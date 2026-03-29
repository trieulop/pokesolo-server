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

// ====== GAME DATA REPLICATED FROM CLIENT ======
const Rarity = {
    'common': { multiplier: 1.0 },
    'rare': { multiplier: 1.2 },
    'epic': { multiplier: 1.5 },
    'legendary': { multiplier: 2.0 }
};

const TypeEffectiveness = {
    fire: { strongAgainst: ['grass', 'bug', 'ice', 'steel'], weakAgainst: ['water', 'ground', 'rock'] },
    water: { strongAgainst: ['fire', 'ground', 'rock'], weakAgainst: ['electric', 'grass'] },
    grass: { strongAgainst: ['water', 'ground', 'rock'], weakAgainst: ['fire', 'ice', 'poison', 'flying', 'bug'] },
    electric: { strongAgainst: ['water', 'flying'], weakAgainst: ['ground'] },
    ice: { strongAgainst: ['grass', 'ground', 'flying', 'dragon'], weakAgainst: ['fire', 'fighting', 'rock', 'steel'] },
    fighting: { strongAgainst: ['normal', 'ice', 'rock', 'dark', 'steel'], weakAgainst: ['flying', 'psychic', 'fairy'] },
    poison: { strongAgainst: ['grass', 'fairy'], weakAgainst: ['ground', 'psychic'] },
    ground: { strongAgainst: ['fire', 'electric', 'poison', 'rock', 'steel'], weakAgainst: ['water', 'grass', 'ice'] },
    flying: { strongAgainst: ['grass', 'fighting', 'bug'], weakAgainst: ['electric', 'ice', 'rock'] },
    psychic: { strongAgainst: ['fighting', 'poison'], weakAgainst: ['bug', 'ghost', 'dark'] },
    bug: { strongAgainst: ['grass', 'psychic', 'dark'], weakAgainst: ['fire', 'flying', 'rock'] },
    rock: { strongAgainst: ['fire', 'ice', 'flying', 'bug'], weakAgainst: ['water', 'grass', 'fighting', 'ground', 'steel'] },
    ghost: { strongAgainst: ['psychic', 'ghost'], weakAgainst: ['ghost', 'dark'] },
    dragon: { strongAgainst: ['dragon'], weakAgainst: ['ice', 'dragon', 'fairy'] },
    dark: { strongAgainst: ['psychic', 'ghost'], weakAgainst: ['fighting', 'bug', 'fairy'] },
    steel: { strongAgainst: ['ice', 'rock', 'fairy'], weakAgainst: ['fire', 'fighting', 'ground'] },
    fairy: { strongAgainst: ['fighting', 'dragon', 'dark'], weakAgainst: ['poison', 'steel'] },
    normal: { strongAgainst: [], weakAgainst: ['fighting'] }
};

const Skills = {
    'tackle': { name: 'たいあたり', type: 'attack', power: 40, element: 'normal' },
    'fireblast': { name: 'だいもんじ', type: 'attack', power: 90, element: 'fire' },
    'quickattack': { name: 'でんこうせっか', type: 'attack', power: 30, element: 'normal' },
    'heal': { name: 'じこさいせい', type: 'heal', power: 40, element: 'normal' },
    'shield': { name: 'まもる', type: 'buff', power: 50, element: 'normal' },
    'hydropump': { name: 'ハイドロポンプ', type: 'attack', power: 110, element: 'water' },
    'solarbeam': { name: 'ソーラービーム', type: 'attack', power: 120, element: 'grass' }
};

// Simplified Pokemon list for random generation (IDs only for API fetch on client)
const PokePool = [25, 6, 9, 3, 150, 149, 130, 94, 65, 38, 59, 131, 143, 248, 448, 700];

// ====== SERVER STATE ======
let queue = [];
let rooms = {};

// ====== UTILS ======
function getEffectiveness(attackType, defenderTypes) {
    if (!attackType || attackType === 'normal') return 1.0;
    let mult = 1.0;
    let data = TypeEffectiveness[attackType];
    if(!data) return 1.0;
    for (let t of defenderTypes) {
        if (data.strongAgainst.includes(t)) mult *= 2.0;
        if (data.weakAgainst.includes(t)) mult *= 0.5;
    }
    return mult;
}

function generatePokemonOptions() {
    let options = [];
    for(let i=0; i<4; i++) {
        let id = PokePool[Math.floor(Math.random() * PokePool.length)];
        let rarity = ['common', 'rare', 'epic', 'legendary'][Math.floor(Math.random() * 4)];
        options.push({ id, rarity });
    }
    return options;
}

// ====== LOGIC ======
function createRoom(p1, p2) {
    const roomId = "room_" + Math.random().toString(36).substring(2, 9);
    rooms[roomId] = {
        id: roomId,
        players: {
            [p1.id]: { id: p1.id, name: p1.name, socket: p1, options: generatePokemonOptions(), isAI: false },
            [p2.id]: { id: p2.id, name: p2.name, socket: p2, options: generatePokemonOptions(), isAI: p2.isAI || false }
        },
        playerIds: [p1.id, p2.id],
        selections: {},
        fighters: {},
        turnCount: 0,
        state: "selection",
        decision: {} // For retry
    };

    p1.join(roomId);
    if(!p2.isAI) p2.join(roomId);

    io.to(roomId).emit("match_found", {
        roomId,
        players: [
            { id: p1.id, name: p1.name },
            { id: p2.id, name: p2.name }
        ]
    });

    startSelection(roomId);
}

function startSelection(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.playerIds.forEach(pid => {
        const p = room.players[pid];
        if(!p.isAI) {
            p.socket.emit("selection_start", {
                options: p.options,
                duration: 30
            });
        }
    });

    // AI selects instantly
    const aiId = room.playerIds.find(pid => room.players[pid].isAI);
    if(aiId) {
        setTimeout(() => {
            const opt = room.players[aiId].options[0];
            room.selections[aiId] = opt;
            checkSelectionComplete(roomId);
        }, 1000);
    }

    // Backup timeout
    room.selectionTimeout = setTimeout(() => {
        autoSelect(roomId);
    }, 31000);
}

function autoSelect(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.playerIds.forEach(pid => {
        if (!room.selections[pid]) {
            room.selections[pid] = room.players[pid].options[0];
        }
    });
    startBattle(roomId);
}

function checkSelectionComplete(roomId) {
    const room = rooms[roomId];
    if (!room || Object.keys(room.selections).length < 2) return;
    clearTimeout(room.selectionTimeout);
    startBattle(roomId);
}

// ====== BATTLE LOGIC (Manual / Turn-based) ======
function startBattle(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = "battle";
    room.currentTurnPlayerId = null;

    // Initialize stamina: 30 + (spd / 3)
    room.playerIds.forEach(pid => {
        const f = room.fighters[pid];
        f.stamina = Math.min(100, 30 + (f.spd / 3));
    });

    io.to(roomId).emit("battle_start", {
        fighters: room.fighters
    });

    setTimeout(() => nextTurn(roomId), 1500);
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "battle") return;

    // Determine whose turn it is
    const p1Id = room.playerIds[0];
    const p2Id = room.playerIds[1];
    const f1 = room.fighters[p1Id];
    const f2 = room.fighters[p2Id];

    if (!room.currentTurnPlayerId) {
        // Decide first attacker based on SPD
        if (f1.spd > f2.spd) room.currentTurnPlayerId = p1Id;
        else if (f2.spd > f1.spd) room.currentTurnPlayerId = p2Id;
        else room.currentTurnPlayerId = Math.random() < 0.5 ? p1Id : p2Id;
    } else {
        // Switch turn
        room.currentTurnPlayerId = (room.currentTurnPlayerId === p1Id) ? p2Id : p1Id;
    }

    const activeId = room.currentTurnPlayerId;
    const activePlayer = room.players[activeId];
    const activeFighter = room.fighters[activeId];

    // Refund stamina based on SPD: 10 + (SPD / 10)
    const regen = 10 + (activeFighter.spd / 10);
    activeFighter.stamina = Math.min(100, activeFighter.stamina + regen);

    // Notify turn start and status
    io.to(roomId).emit("turn_start", {
        playerId: activeId,
        fighters: room.fighters // Sync HP/SP
    });

    if (activePlayer.isAI) {
        setTimeout(() => {
            const skill = chooseSkillServer(activeFighter, room.fighters[activeId === p1Id ? p2Id : p1Id]);
            processSkillUse(roomId, activeId, skill.id);
        }, 1500);
    } else {
        // Request action from human player
        activePlayer.socket.emit("request_action");
        
        // Timeout backup (30s)
        clearTimeout(room.actionTimeout);
        room.actionTimeout = setTimeout(() => {
            if (room.currentTurnPlayerId === activeId) {
                const skill = chooseSkillServer(activeFighter, room.fighters[activeId === p1Id ? p2Id : p1Id]);
                processSkillUse(roomId, activeId, skill.id);
            }
        }, 30000);
    }
}

function processSkillUse(roomId, playerId, skillId) {
    const room = rooms[roomId];
    if (!room || room.state !== "battle" || room.currentTurnPlayerId !== playerId) return;
    clearTimeout(room.actionTimeout);

    const attacker = room.fighters[playerId];
    const defenderId = room.playerIds.find(id => id !== playerId);
    const defender = room.fighters[defenderId];
    const skill = attacker.skills[skillId]; // Use pokemon's specific skill data

    if (!skill) return;

    // Stamina check
    const cost = getStaminaCost(skill);
    if (attacker.stamina < cost) {
        // Fallback to tackle if not enough stamina
        processSkillUse(roomId, playerId, 'tackle');
        return;
    }

    attacker.stamina -= cost;
    executeAction(roomId, playerId, defenderId, skillId);
}

function getStaminaCost(skill) {
    if (skill.type === 'attack') return Math.round(skill.power * 0.3);
    return 10; // heal/buff
}

async function executeAction(roomId, attackerId, defenderId, skillId) {
    const room = rooms[roomId];
    if (!room) return;

    const attacker = room.fighters[attackerId];
    const defender = room.fighters[defenderId];
    const skill = Skills[skillId];

    room.turnCount++;
    const roundCount = Math.floor((room.turnCount - 1) / 2);
    const damageMult = 1.0 + (roundCount * 0.05);
    const healMult = Math.max(0.1, 1.0 - (roundCount * 0.05));

    attacker.isProtecting = false;

    let result = {
        attackerId,
        defenderId,
        skillId: skillId,
        skillName: skill.name,
        type: skill.type,
        damage: 0,
        heal: 0,
        isProtecting: false,
        effectiveness: 1.0,
        hp: {},
        stamina: { [attackerId]: attacker.stamina }
    };

    if (skill.type === 'heal') {
        let baseHeal = Math.max(15, Math.floor(40 * healMult));
        let healAmount = Math.floor(attacker.maxHp * (baseHeal / 100));
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmount);
        result.heal = healAmount;
    } else if (skill.type === 'buff') {
        attacker.isProtecting = true;
        result.isProtecting = true;
    } else {
        let effort = getEffectiveness(skill.element, defender.types);
        let finalDmgMult = effort;
        if (defender.isProtecting) {
            finalDmgMult *= 0.5;
            defender.isProtecting = false;
        }

        let baseDmg = (attacker.atk * (skill.power || 40)) / 50;
        baseDmg = (baseDmg / 5) * damageMult;
        let actualDmg = Math.floor(baseDmg * (0.8 + Math.random()*0.4) * finalDmgMult);
        let mitigated = Math.max(1, Math.floor(actualDmg * (100 / (100 + defender.def))));
        defender.hp = Math.max(0, defender.hp - mitigated);
        result.damage = mitigated;
        result.effectiveness = effort;
    }

    result.hp = { [attackerId]: attacker.hp, [defenderId]: defender.hp };

    io.to(roomId).emit("battle_step", result);

    if (defender.hp <= 0) {
        room.state = "finished";
        setTimeout(() => {
            io.to(roomId).emit("battle_end", {
                winnerId: attackerId,
                winnerName: room.players[attackerId].name,
                pokemonName: attacker.name
            });
        }, 1500);
    } else {
        setTimeout(() => nextTurn(roomId), 2500);
    }
}

function chooseSkillServer(attacker, defender) {
    // Simple version of AIController
    let available = Object.keys(attacker.skills).map(id => ({ id, ...Skills[id] }));
    if (attacker.hp / attacker.maxHp < 0.4 && available.some(s => s.id === 'heal')) {
         if (Math.random() < 0.7) return available.find(s => s.id === 'heal');
    }
    // Just random attack for now or highest power
    let attacks = available.filter(s => s.type === 'attack');
    attacks.sort((a, b) => b.power - a.power);
    return attacks[0] || available[0];
}

// ====== SOCKET ======
io.on("connection", (socket) => {
    socket.on("set_name", (name) => {
        socket.name = name || "Trainer";
    });

    socket.on("find_match", () => {
        // Remove from queue if already in
        queue = queue.filter(s => s.id !== socket.id);
        
        if (queue.length > 0) {
            const opponent = queue.shift();
            createRoom(socket, opponent);
        } else {
            queue.push(socket);
            socket.matchTimeout = setTimeout(() => {
                if (queue.includes(socket)) {
                    queue = queue.filter(s => s !== socket);
                    const aiPlayer = { id: "AI_" + Math.random(), name: "AI Rival", isAI: true };
                    createRoom(socket, aiPlayer);
                }
            }, 30000);
        }
    });

    socket.on("select_pokemon", (data) => {
        const { roomId, pokemonData } = data;
        const room = rooms[roomId];
        if (!room) return;

        room.selections[socket.id] = pokemonData;
        room.fighters[socket.id] = {
            ...pokemonData,
            hp: pokemonData.maxHp,
            isProtecting: false
        };

        if (Object.keys(room.selections).length === 2 || (Object.keys(room.selections).length === 1 && room.playerIds.some(id => room.players[id].isAI))) {
            // If AI is present, it's already selected
            if (room.playerIds.some(id => room.players[id].isAI)) {
                const aiId = room.playerIds.find(id => room.players[id].isAI);
                const aiOpt = room.players[aiId].options[0];
                // Mocking AI selection
                room.fighters[aiId] = {
                    id: aiOpt.id,
                    name: "AI Pokemon",
                    maxHp: 200, hp: 200, atk: 50, def: 50, spd: 50,
                    types: ['normal'],
                    skills: { 'tackle': Skills['tackle'] },
                    isProtecting: false
                };
            }
            checkSelectionComplete(roomId);
        }
    });

    socket.on("retry_decision", ({ roomId, accept }) => {
        const room = rooms[roomId];
        if (!room) return;
        room.decision[socket.id] = accept;
        
        const otherId = room.playerIds.find(id => id !== socket.id);
        const other = room.players[otherId];

        if (!accept) {
            if (other && !other.isAI) other.socket.emit("retry_declined");
            return;
        }

        if (other && other.isAI && accept) {
            // AI always accepts
            createRoom(socket, other);
            return;
        }

        const [id1, id2] = room.playerIds;
        if (room.decision[id1] && room.decision[id2]) {
            const p1 = room.players[id1].socket;
            const p2 = room.players[id2].socket;
            createRoom(p1, p2);
        }
    });

    socket.on("use_skill", (data) => {
        const { roomId, skillId } = data;
        processSkillUse(roomId, socket.id, skillId);
    });

    socket.on("disconnect", () => {
        queue = queue.filter(s => s.id !== socket.id);
        // Handle room disconnect -> Notify other player
        for (let rid in rooms) {
            if (rooms[rid].playerIds.includes(socket.id)) {
                const otherId = rooms[rid].playerIds.find(id => id !== socket.id);
                const other = rooms[rid].players[otherId];
                if (other && !other.isAI) {
                    other.socket.emit("opponent_disconnected");
                }
                delete rooms[rid];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("PokeSolo Server running on port", PORT);
});
