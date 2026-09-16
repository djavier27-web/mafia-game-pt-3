const socket = io();

let roomCode = "";

// Element Selectors
const homeSec = document.getElementById("home");
const lobbySec = document.getElementById("lobby");
const gameSec = document.getElementById("game");

function showSection(section) {
    homeSec.classList.add("hidden");
    lobbySec.classList.add("hidden");
    gameSec.classList.add("hidden");

    section.classList.remove("hidden");
}

function getName() {
    const name = document.getElementById("name").value.trim();
    if (!name) {
        alert("Masukkan Nama Agen terlebih dahulu.");
        return null;
    }
    return name;
}

function createRoom() {
    const name = getName();
    if (name) socket.emit("createRoom", name);
}

function joinRoom() {
    const name = getName();
    const code = document.getElementById("roomCode").value.trim().toUpperCase();

    if (!name) return;
    if (!code) {
        alert("Masukkan Kode Sektor Ruangan.");
        return;
    }

    socket.emit("joinRoom", { name, code });
}

function startGame() {
    socket.emit("startGame", roomCode);
}

function playAgain() {
    socket.emit("replayGame", roomCode);
}

// CHAT HANDLERS
function sendChat() {
    const input = document.getElementById("chatInput");
    const msg = input.value.trim();
    if (msg) {
        socket.emit("sendChatMessage", { code: roomCode, message: msg });
        input.value = "";
    }
}

function sendGameChat() {
    const input = document.getElementById("gameChatInput");
    const msg = input.value.trim();
    if (msg) {
        socket.emit("sendChatMessage", { code: roomCode, message: msg });
        input.value = "";
    }
}

function renderMessage(containerId, data) {
    const box = document.getElementById(containerId);
    if (!box) return;

    const msgDiv = document.createElement("div");
    msgDiv.className = `chat-msg ${data.isAnon ? 'anon' : ''}`;
    
    msgDiv.innerHTML = `
        <span class="sender">${data.sender}:</span>
        <span class="text">${data.text}</span>
        <span class="time" style="font-size:10px; color:#555; margin-left:5px;">${data.time}</span>
    `;

    box.appendChild(msgDiv);
    box.scrollTop = box.scrollHeight;
}

// SOCKET LISTENERS
socket.on("roomCreated", code => {
    roomCode = code;
    showSection(lobbySec);
});

socket.on("roomJoined", code => {
    roomCode = code;
    showSection(lobbySec);
});

socket.on("roomState", data => {
    roomCode = data.code;
    document.getElementById("code").textContent = data.code;

    const playersDiv = document.getElementById("players");
    playersDiv.innerHTML = "";

    data.players.forEach(p => {
        const div = document.createElement("div");
        div.className = "player";
        div.textContent = p.name + (p.isHost ? " 👑 [HOST]" : "") + (!p.alive ? " 💀 [TERELIMINASI]" : "");
        playersDiv.appendChild(div);
    });

    const startBtn = document.querySelector("#lobby button.full-width");
    if (startBtn) {
        startBtn.style.display = (socket.id === data.hostId && data.state === "LOBBY") ? "block" : "none";
    }
});

socket.on("roleAssigned", data => {
    document.getElementById("role").textContent = data.role;
    showSection(gameSec);
});

socket.on("phaseChange", data => {
    document.getElementById("phase").textContent = 
        data.phase === "night" ? `MALAM ${data.day}` : `SIANG ${data.day}`;
    document.getElementById("narrator").textContent = data.message;
    document.getElementById("actions").innerHTML = "";

    const header = document.getElementById("chatPhaseIndicator");
    if (data.phase === "night") {
        header.textContent = "TERMINAL CHAT (MODE ANONIM TERSAMAR)";
        header.style.color = "var(--neon-red)";
    } else {
        header.textContent = "TERMINAL CHAT (MODE PUBLIK)";
        header.style.color = "var(--neon-cyan)";
    }
});

socket.on("chatMessage", data => {
    renderMessage("chatMessages", data);
    renderMessage("gameChatMessages", data);
});

socket.on("nightActionPrompt", data => {
    const actionsDiv = document.getElementById("actions");
    actionsDiv.innerHTML = "<h3>EKSEKUSI AKSI MALAM:</h3>";

    data.targets.forEach(target => {
        const btn = document.createElement("button");
        btn.className = "action";
        btn.textContent = `TARGET: ${target.name}`;
        btn.onclick = () => {
            socket.emit("nightAction", { code: roomCode, targetId: target.id });
            actionsDiv.innerHTML = "<p>Perintah terkirim ke jaringan...</p>";
        };
        actionsDiv.appendChild(btn);
    });
});

socket.on("votingPrompt", data => {
    const actionsDiv = document.getElementById("actions");
    actionsDiv.innerHTML = "<h3>VOTING ELIMINASI:</h3>";

    data.targets.forEach(target => {
        const btn = document.createElement("button");
        btn.className = "action";
        btn.textContent = `VOTE: ${target.name}`;
        btn.onclick = () => {
            socket.emit("vote", { code: roomCode, targetId: target.id });
            actionsDiv.innerHTML = "<p>Vote terdaftar.</p>";
        };
        actionsDiv.appendChild(btn);
    });
});

socket.on("detectiveResult", data => {
    alert(`[HASIL ANALISIS DETEKTIF]\nSubjek: ${data.name}\nPeran: ${data.role}`);
});

socket.on("gameEnded", data => {
    document.getElementById("narrator").textContent = data.text;

    const actionsDiv = document.getElementById("actions");
    let html = `<h2 class="highlight-text">${data.winner.toUpperCase()} MENANG</h2>`;

    if (socket.id === data.hostId) {
        html += `<button class="btn btn-primary" onclick="playAgain()">MAIN LAGI (RESET RUANGAN)</button>`;
    } else {
        html += `<p>Menunggu Host untuk reset sektor...</p>`;
    }

    actionsDiv.innerHTML = html;
});

socket.on("returnToLobby", () => {
    showSection(lobbySec);
    document.getElementById("actions").innerHTML = "";
    document.getElementById("role").textContent = "-";
});

socket.on("errorMessage", msg => {
    alert(msg);
});