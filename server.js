const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const line = require('@line/bot-sdk');
const axios = require('axios');

const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

let currentDefaultId = "QngwLXMRTSc"; // 初期値

function toHalfWidth(str) {
    if (!str) return "";
    return str.replace(/[Ａ-Ｚａ-ｚ０-９]/g, function(s) {
        return String.fromCharCode(s.charCodeAt(0) - 0xFEE0);
    }).replace(/　/g, ' ').trim();
}

function parseDefaultCommand(text) {
    const normalized = toHalfWidth(text);
    const match = normalized.match(/^default\s*\[?(.+?)\]?$/i) || normalized.match(/^default\s+(.+)$/i);
    if (match) return match[1].trim();
    if (normalized.toLowerCase().startsWith('default[')) {
        return normalized.substring(7).replace(/\]$/, '').trim();
    }
    return null;
}

// --- LINE Webhook ---
app.post('/callback', line.middleware(config), (req, res) => {
    Promise.all(req.body.events.map(handleLineEvent))
        .then((result) => res.json(result))
        .catch((err) => {
            console.error("LINE Error:", err.originalError?.response?.data || err);
            res.status(500).end();
        });
});

async function handleLineEvent(event) {
    const client = new line.Client(config);

    // ★ ポストバック処理（ボタンが押された時）
    if (event.type === 'postback') {
        const data = new URLSearchParams(event.postback.data);
        const videoId = data.get('videoId');
        const mode = data.get('mode'); // ★モード判定を追加

        // A. デフォルト変更モードの場合
        if (mode === 'default') {
            currentDefaultId = videoId;
            io.emit('update-default', { videoId: videoId });
            io.emit('chat-message', `🔄 LINEからデフォルトBGMが変更されました`);
            return client.replyMessage(event.replyToken, { 
                type: 'text', text: `✅ デフォルトBGMを変更しました！` 
            });
        }

        // B. 通常の予約モードの場合
        io.emit('add-queue', { videoId, title: 'LINEからのリクエスト', source: 'LINE' });
        return client.replyMessage(event.replyToken, { 
            type: 'text', text: `✅ リクエストを受け付けました！` 
        });
    }

    if (event.type === 'message' && event.message.type === 'text') {
        const rawText = event.message.text;

        // ★ defaultコマンド
        const defaultCommandQuery = parseDefaultCommand(rawText);
        if (defaultCommandQuery) {
            let newId = extractYouTubeId(defaultCommandQuery);

            // 1. URLが直接指定された場合 → 即変更
            if (newId) {
                currentDefaultId = newId;
                io.emit('update-default', { videoId: newId });
                io.emit('chat-message', `🔄 LINEからデフォルトBGMが変更されました`);
                return client.replyMessage(event.replyToken, { type: 'text', text: '✅ デフォルトBGMを変更しました！' });
            }

            // 2. キーワードの場合 → 検索結果（選択肢）を返す
            if (YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(defaultCommandQuery);
                    if (!items || items.length === 0) {
                        return client.replyMessage(event.replyToken, { type: 'text', text: '😢 見つかりませんでした' });
                    }
                    // ★「デフォルト設定用」のボタンを作成（mode=defaultをつける）
                    const bubbles = createCarousel(items, "設定する", "default");
                    return client.replyMessage(event.replyToken, { type: "flex", altText: "デフォルト変更", contents: { type: "carousel", contents: bubbles } });
                } catch (e) {
                    return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ エラーが発生しました' });
                }
            }
            return;
        }

        // コメント、URL、通常検索など
        if (rawText.startsWith('#')) { io.emit('flow-comment', rawText); return; }
        const normalizedText = toHalfWidth(rawText);
        if (isUrl(normalizedText) || isCommand(normalizedText)) { 
            io.emit('chat-message', normalizedText); 
            return client.replyMessage(event.replyToken, { type: 'text', text: '✅ 受け付けました' });
        }

        // 通常検索
        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(rawText);
                if (!items || items.length === 0) return client.replyMessage(event.replyToken, { type: 'text', text: '😢 なし' });
                
                // ★通常の予約ボタン（mode=queue、または指定なし）
                const bubbles = createCarousel(items, "予約する", "queue");
                return client.replyMessage(event.replyToken, { type: "flex", altText: "検索結果", contents: { type: "carousel", contents: bubbles } });
            } catch (error) { return client.replyMessage(event.replyToken, { type: 'text', text: '⚠️ エラー' }); }
        }
    }
}

// --- Socket.io (Web版) ---
io.on('connection', (socket) => {
    socket.emit('init-state', { defaultId: currentDefaultId });

    socket.on('client-input', async (rawText) => {
        // ★ defaultコマンド
        const defaultCommandQuery = parseDefaultCommand(rawText);
        if (defaultCommandQuery) {
            let newId = extractYouTubeId(defaultCommandQuery);
            // URLなら即変更
            if (newId) {
                currentDefaultId = newId;
                io.emit('update-default', { videoId: newId });
                io.emit('chat-message', `🔄 PCからデフォルトBGMが変更されました`);
                return;
            }
            // キーワードなら「デフォルト設定用」の検索結果を個別に返す
            if (YOUTUBE_API_KEY) {
                try {
                    const items = await searchYouTube(defaultCommandQuery);
                    // ★特別なイベント名で返す
                    socket.emit('search-results-for-default', items);
                } catch(e) {}
            }
            return;
        }
        
        // 以下通常処理
        if (rawText.startsWith('#')) { io.emit('flow-comment', rawText); return; }
        const normalizedText = toHalfWidth(rawText);
        if (isUrl(normalizedText) || isCommand(normalizedText)) { io.emit('chat-message', normalizedText); return; }

        if (YOUTUBE_API_KEY) {
            try {
                const items = await searchYouTube(rawText);
                socket.emit('search-results', items); // 通常検索結果
            } catch(e) {}
        }
    });

    // 通常の予約
    socket.on('select-video', (data) => {
        io.emit('add-queue', { videoId: data.videoId, title: data.title, source: 'PC' });
    });

    // ★ 新追加: デフォルト変更の確定
    socket.on('select-default', (data) => {
        currentDefaultId = data.videoId;
        io.emit('update-default', { videoId: data.videoId });
        io.emit('chat-message', `🔄 PCからデフォルトBGMが変更されました: ${data.title}`);
    });
});

app.use(express.static('public'));

// 共通ヘルパー: LINEのカルーセルを作る関数
function createCarousel(items, buttonLabel, mode) {
    return items.map(item => ({
        type: "bubble", size: "kilo",
        hero: { type: "image", url: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : "https://via.placeholder.com/320", size: "full", aspectRatio: "16:9", aspectMode: "cover" },
        body: { type: "box", layout: "vertical", contents: [{ type: "text", text: item.snippet.title, wrap: true, weight: "bold", size: "sm" }] },
        footer: {
            type: "box", layout: "vertical", contents: [{
                type: "button", style: "primary", color: mode === 'default' ? "#E04F5F" : "#1DB446", // デフォルト設定は赤色ボタン
                action: { type: "postback", label: buttonLabel, data: `videoId=${item.id.videoId}&mode=${mode}` } // modeを埋め込む
            }]
        }
    }));
}

function isUrl(text) { return text.includes('youtube.com') || text.includes('youtu.be'); }
function isCommand(text) { return text === 'スキップ' || text.toLowerCase() === 'skip'; }
function extractYouTubeId(url) {
    const match = url.match(/^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/);
    return (match && match[2].length === 11) ? match[2] : null;
}
async function searchYouTube(query) {
    if (!YOUTUBE_API_KEY) throw new Error("No API Key");
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&type=video&maxResults=3`;
    const res = await axios.get(url);
    return res.data.items;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
