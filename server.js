const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// "public" フォルダの中身をブラウザに公開する
app.use(express.static('public'));

// 誰かがサイトにアクセスした時の処理
io.on('connection', (socket) => {
    console.log('ユーザーが接続しました');

    // クライアント（ブラウザ）からメッセージやURLが届いた時
    socket.on('chat-message', (msg) => {
        // 受け取ったメッセージを、接続している全員に転送（ブロードキャスト）
        io.emit('chat-message', msg);
    });

    socket.on('disconnect', () => {
        console.log('ユーザーが切断しました');
    });
});

// サーバー起動 (Renderが指定するポート または 3000番)
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});