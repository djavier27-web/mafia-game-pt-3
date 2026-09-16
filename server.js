const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static("public"));

app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "index.html"));
});

const rooms = new Map();

const ROLES = {
    MAFIA: "Mafia",
    VILLAGER: "Warga",
    DETECTIVE: "Detektif",
    DOCTOR: "Dokter",
    JOKER: "Joker",
    PROSTITUTE: "Pelacur"
};

function generateCode() {
    let code;
    do {
        code = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (rooms.has(code));
    return code;
}

function shuffle(array) {
    return array.sort(() => Math.random() - 0.5);
}

function getAlivePlayers(room) {
    return room.players.filter(p => p.alive);
}

function getPlayer(room, id) {
    return room.players.find(p => p.id === id);
}

function broadcastState(room) {
    const publicPlayers = room.players.map(p => ({
        id: p.id,
        name: p.name,
        alive: p.alive,
        isHost: p.id === room.hostId
    }));

    io.to(room.code).emit("roomState", {
        code: room.code,
        hostId: room.hostId,
        state: room.state,
        players: publicPlayers,
        day: room.day
    });
}

function assignRoles(room) {
    const count = room.players.length;
    let roles = [ROLES.MAFIA];

    if (count >= 5) roles.push(ROLES.DETECTIVE);
    if (count >= 6) roles.push(ROLES.DOCTOR);
    if (count >= 7) roles.push(ROLES.JOKER);
    if (count >= 8) roles.push(ROLES.PROSTITUTE);

    while (roles.length < count) {
        roles.push(ROLES.VILLAGER);
    }

    roles = shuffle(roles);

    room.players.forEach((p, idx) => {
        p.role = roles[idx];
        p.alive = true;
    });
}

function startGame(room) {
    if (room.state !== "LOBBY") return;

    assignRoles(room);
    room.state = "NIGHT";
    room.day = 1;
    room.actions = {};
    room.votes = {};

    room.players.forEach(p => {
        io.to(p.id).emit("roleAssigned", { role: p.role });
    });

    broadcastState(room);
    startNight(room);
}

function startNight(room) {
    room.state = "NIGHT";
    room.actions = {};

    io.to(room.code).emit("phaseChange", {
        phase: "night",
        day: room.day,
        message: `Malam ${room.day}. Sektor kegelapan aktif. Jalankan aksi dan gunakan chat anonim!`
    });

    const alive = getAlivePlayers(room);

    alive.forEach(p => {
        if ([ROLES.MAFIA, ROLES.DOCTOR, ROLES.DETECTIVE, ROLES.PROSTITUTE].includes(p.role)) {
            const targets = alive.filter(t => t.id !== p.id).map(t => ({ id: t.id, name: t.name }));
            io.to(p.id).emit("nightActionPrompt", { targets });
        }
    });
}

function resolveNight(room) {
    let mafiaTarget = null;
    let doctorTarget = null;
    let blockedPlayer = null;

    const mafia = room.players.find(p => p.alive && p.role === ROLES.MAFIA);
    const doctor = room.players.find(p => p.alive && p.role === ROLES.DOCTOR);
    const detective = room.players.find(p => p.alive && p.role === ROLES.DETECTIVE);
    const prostitute = room.players.find(p => p.alive && p.role === ROLES.PROSTITUTE);

    if (mafia && room.actions[mafia.id]) mafiaTarget = room.actions[mafia.id];
    if (doctor && room.actions[doctor.id]) doctorTarget = room.actions[doctor.id];
    if (prostitute && room.actions[prostitute.id]) blockedPlayer = room.actions[prostitute.id];

    if (detective && room.actions[detective.id]) {
        const target = getPlayer(room, room.actions[detective.id]);
        if (target) {
            io.to(detective.id).emit("detectiveResult", { name: target.name, role: target.role });
        }
    }

    let deathMessage = "Fajar menyingsing. Seluruh jaringan aman, tidak ada korban tewas malam ini.";

    if (mafiaTarget && mafiaTarget !== doctorTarget && mafiaTarget !== blockedPlayer) {
        const victim = getPlayer(room, mafiaTarget);
        if (victim && victim.alive) {
            victim.alive = false;
            deathMessage = `Sistem diretas! Korban tereliminasi: ${victim.name}`;
        }
    }

    broadcastState(room);

    if (checkWinner(room)) return;

    startDay(room, deathMessage);
}

function startDay(room, narratorMsg) {
    room.state = "DAY";
    room.votes = {};

    io.to(room.code).emit("phaseChange", {
        phase: "day",
        day: room.day,
        message: narratorMsg + " Lakukan eliminasi lewat voting!"
    });

    const alive = getAlivePlayers(room).map(p => ({ id: p.id, name: p.name }));
    io.to(room.code).emit("votingPrompt", { targets: alive });
}

function resolveVoting(room) {
    const counts = {};
    Object.values(room.votes).forEach(targetId => {
        counts[targetId] = (counts[targetId] || 0) + 1;
    });

    let highest = 0;
    let selected = null;
    let tie = false;

    for (const [id, count] of Object.entries(counts)) {
        if (count > highest) {
            highest = count;
            selected = id;
            tie = false;
        } else if (count === highest && count > 0) {
            tie = true;
        }
    }

    if (!selected || tie) {
        io.to(room.code).emit("narrator", "Voting seimbang. Tidak ada eliminasi siang ini.");
    } else {
        const victim = getPlayer(room, selected);
        if (victim) {
            victim.alive = false;
            io.to(room.code).emit("narrator", `${victim.name} dieksekusi oleh protokol mayoritas!`);

            if (victim.role === ROLES.JOKER) {
                finishGame(room, "Joker", `${victim.name} adalah Joker. Anarki menang!`);
                return;
            }
        }
    }

    broadcastState(room);

    if (checkWinner(room)) return;

    room.day++;
    startNight(room);
}

function checkWinner(room) {
    const alive = getAlivePlayers(room);
    const mafiaCount = alive.filter(p => p.role === ROLES.MAFIA).length;
    const othersCount = alive.length - mafiaCount;

    if (mafiaCount === 0) {
        finishGame(room, "Warga", "Infiltrator berhasil dibersihkan! Warga Menang!");
        return true;
    }

    if (mafiaCount >= othersCount) {
        finishGame(room, "Mafia", "Kota jatuh ke tangan Sindikat! Mafia Menang!");
        return true;
    }

    return false;
}

function finishGame(room, winner, text) {
    room.state = "ENDED";
    broadcastState(room);
    io.to(room.code).emit("gameEnded", { winner, text, hostId: room.hostId });
}

// Socket Handlers
io.on("connection", socket => {

    socket.on("createRoom", name => {
        const code = generateCode();
        const room = {
            code,
            hostId: socket.id,
            state: "LOBBY",
            day: 1,
            players: [{ id: socket.id, name, role: null, alive: true }],
            actions: {},
            votes: {}
        };

        rooms.set(code, room);
        socket.join(code);
        socket.emit("roomCreated", code);
        broadcastState(room);
    });

    socket.on("joinRoom", ({ name, code }) => {
        code = code.toUpperCase();
        const room = rooms.get(code);

        if (!room) return socket.emit("errorMessage", "Ruangan tidak ditemukan.");
        if (room.state !== "LOBBY") return socket.emit("errorMessage", "Permainan sudah berlangsung.");
        if (room.players.length >= 12) return socket.emit("errorMessage", "Ruangan penuh.");

        room.players.push({ id: socket.id, name, role: null, alive: true });
        socket.join(code);
        socket.emit("roomJoined", code);
        broadcastState(room);
    });

    socket.on("startGame", code => {
        const room = rooms.get(code);
        if (!room) return;
        if (socket.id !== room.hostId) return socket.emit("errorMessage", "Hanya Host yang dapat memulai.");
        if (room.state !== "LOBBY") return;
        if (room.players.length < 4) return socket.emit("errorMessage", "Minimal 4 pemain untuk memulai.");

        startGame(room);
    });

    // SISTEM CHAT (ANONIM & PUBLIK)
    socket.on("sendChatMessage", ({ code, message }) => {
        const room = rooms.get(code);
        if (!room || !message || message.trim() === "") return;

        const player = getPlayer(room, socket.id);
        if (!player) return;

        let senderName = player.name;
        let isAnon = false;

        // Jika fase malam, nama otomatis disamarkan jadi Anonim
        if (room.state === "NIGHT") {
            senderName = "Bayangan Anonim";
            isAnon = true;
        }

        io.to(room.code).emit("chatMessage", {
            sender: senderName,
            text: message.trim(),
            isAnon: isAnon,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        });
    });

    socket.on("nightAction", ({ code, targetId }) => {
        const room = rooms.get(code);
        if (!room || room.state !== "NIGHT") return;

        const player = getPlayer(room, socket.id);
        if (!player || !player.alive) return;

        room.actions[player.id] = targetId;
        socket.emit("actionDone");

        const activeRoles = [ROLES.MAFIA, ROLES.DOCTOR, ROLES.DETECTIVE, ROLES.PROSTITUTE];
        const requiredPlayers = getAlivePlayers(room).filter(p => activeRoles.includes(p.role));

        if (requiredPlayers.every(p => room.actions[p.id])) {
            resolveNight(room);
        }
    });

    socket.on("vote", ({ code, targetId }) => {
        const room = rooms.get(code);
        if (!room || room.state !== "DAY") return;

        const player = getPlayer(room, socket.id);
        if (!player || !player.alive) return;

        room.votes[player.id] = targetId;
        socket.emit("actionDone");

        const alive = getAlivePlayers(room);
        if (alive.every(p => room.votes[p.id])) {
            resolveVoting(room);
        }
    });

    socket.on("replayGame", code => {
        const room = rooms.get(code);
        if (!room || room.state !== "ENDED") return;
        if (socket.id !== room.hostId) return socket.emit("errorMessage", "Hanya Host yang bisa mereplay.");

        room.state = "LOBBY";
        room.day = 1;
        room.actions = {};
        room.votes = {};
        room.players.forEach(p => {
            p.role = null;
            p.alive = true;
        });

        broadcastState(room);
        io.to(room.code).emit("returnToLobby");
    });

    socket.on("disconnect", () => {
        for (const [code, room] of rooms) {
            const index = room.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) {
                    rooms.delete(code);
                } else {
                    if (room.hostId === socket.id) {
                        room.hostId = room.players[0].id;
                    }
                    broadcastState(room);
                }
            }
        }
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server Mafia Cyberpunk berjalan di port ${PORT}`);
});