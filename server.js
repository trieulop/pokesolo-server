// ====== INSTALL ======
// npm init -y
// npm install express socket.io cors

// ====== RUN ======
// node server.js

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
  },
});

// ====== DATA ======
let queue = [];
let rooms = {};

// ====== UTIL ======
function createRoom(player1, player2) {
  const roomId = "room_" + Math.random().toString(36).substring(2, 9);

  rooms[roomId] = {
    id: roomId,
    players: [player1.id, player2.id],
    selections: {},
    state: "selection",
  };

  player1.join(roomId);
  player2.join(roomId);

  io.to(roomId).emit("match_found", {
    roomId,
    players: [player1.name, player2.name],
  });

  startSelection(roomId);
}

function startSelection(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  io.to(roomId).emit("selection_start", {
    duration: 30,
  });

  setTimeout(() => {
    autoSelect(roomId);
  }, 30000);
}

function autoSelect(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.players.forEach((pid) => {
    if (!room.selections[pid]) {
      room.selections[pid] = "random_pokemon";
    }
  });

  startBattle(roomId);
}

function startBattle(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  room.state = "battle";

  io.to(roomId).emit("battle_start", {
    selections: room.selections,
  });

  simulateBattle(roomId);
}

function simulateBattle(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  let hp = {
    [room.players[0]]: 100,
    [room.players[1]]: 100,
  };

  const interval = setInterval(() => {
    const attacker = room.players[Math.floor(Math.random() * 2)];
    const defender = room.players.find((p) => p !== attacker);

    const damage = Math.floor(Math.random() * 20) + 5;
    hp[defender] -= damage;

    io.to(roomId).emit("battle_update", {
      attacker,
      defender,
      damage,
      hp,
    });

    if (hp[defender] <= 0) {
      clearInterval(interval);

      io.to(roomId).emit("battle_end", {
        winner: attacker,
      });
    }
  }, 1000);
}

// ====== SOCKET ======
io.on("connection", (socket) => {
  console.log("User connected:", socket.id);

  socket.on("set_name", (name) => {
    socket.name = name;
  });

  socket.on("find_match", () => {
    queue.push(socket);

    if (queue.length >= 2) {
      const p1 = queue.shift();
      const p2 = queue.shift();
      createRoom(p1, p2);
    } else {
      setTimeout(() => {
        if (queue.includes(socket)) {
          queue = queue.filter((s) => s !== socket);
          createAIRoom(socket);
        }
      }, 30000);
    }
  });

  socket.on("select_pokemon", ({ roomId, pokemon }) => {
    const room = rooms[roomId];
    if (!room) return;

    room.selections[socket.id] = pokemon;

    if (Object.keys(room.selections).length === 2) {
      startBattle(roomId);
    }
  });

  socket.on("disconnect", () => {
    console.log("User disconnected:", socket.id);
  });
});

// ====== AI ======
function createAIRoom(player) {
  const roomId = "room_ai_" + Math.random().toString(36).substring(2, 9);

  rooms[roomId] = {
    id: roomId,
    players: [player.id, "AI"],
    selections: {},
    state: "selection",
  };

  player.join(roomId);

  player.emit("match_found", {
    roomId,
    players: [player.name, "AI"],
  });

  startSelection(roomId);

  setTimeout(() => {
    rooms[roomId].selections["AI"] = "random_ai_pokemon";
  }, 2000);
}

// ====== START ======
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
