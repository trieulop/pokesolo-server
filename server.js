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

function startBattle(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = "battle";

    // Data passed from client in 'select_pokemon' should include basic current stats
    // But for a true authoritative server, we ideally fetch stats here too.
    // To keep it simple for now, we'll assume the client sends the Pokemon data.
    io.to(roomId).emit("battle_start", {
        fighters: room.fighters
    });

    setTimeout(() => runBattleLoop(roomId), 1500);
}

async function runBattleLoop(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "battle") return;

    const p1Id = room.playerIds[0];
    const p2Id = room.playerIds[1];
    const f1 = room.fighters[p1Id];
    const f2 = room.fighters[p2Id];

    if (!f1 || !f2) return;

    // Determine order
    let firstId, secondId;
    if (f1.spd > f2.spd) {
        firstId = p1Id; secondId = p2Id;
    } else if (f2.spd > f1.spd) {
        firstId = p2Id; secondId = p1Id;
    } else {
        firstId = Math.random() < 0.5 ? p1Id : p2Id;
        secondId = firstId === p1Id ? p2Id : p1Id;
    }

    // Run Turn 1
    await executeAction(roomId, firstId, secondId);
    if (room.state === "finished") return;

    // Run Turn 2
    setTimeout(async () => {
        await executeAction(roomId, secondId, firstId);
        if (room.state === "finished") return;

        // Next Loop
        setTimeout(() => runBattleLoop(roomId), 2000);
    }, 2000);
}

async function executeAction(roomId, attackerId, defenderId) {
    const room = rooms[roomId];
    if (!room) return;

    const attacker = room.fighters[attackerId];
    const defender = room.fighters[defenderId];
    if (!attacker || !defender || attacker.hp <= 0) return;

    room.turnCount++;
    // Use the 2-action = 1 turn logic as requested earlier
    const roundCount = Math.floor((room.turnCount - 1) / 2);
    const damageMult = 1.0 + (roundCount * 0.05);
    const healMult = Math.max(0.1, 1.0 - (roundCount * 0.05));

    // Reset protection
    attacker.isProtecting = false;

    // AI Logic or Player Input? 
    // In current spec "Server is authoritative", but "AIFallback" means player vs AI.
    // For Player vs Player, we'd wait for input, but the user said "reuse battle engine".
    // I'll make it auto-battle for simplicity like the original, or implement "Wait for input" if Solo implies control.
    // The prompt says "Selection -> Battle", usually implies watching the battle after choosing.
    // BUT "AI uses same logic as AIController" implies automatic skill selection.
    
    // Automatic Skill Selection (Server Side AI)
    const skill = chooseSkillServer(attacker, defender);
    
    let result = {
        attackerId,
        defenderId,
        skillId: skill.id,
        skillName: skill.name,
        type: skill.type,
        damage: 0,
        heal: 0,
        isProtecting: false,
        effectiveness: 1.0,
        hp: {}
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
        // Attack
        let effort = getEffectiveness(skill.element, defender.types);
        let finalDmgMult = effort;
        if (defender.isProtecting) {
            finalDmgMult *= 0.5;
            defender.isProtecting = false;
        }

        let baseDmg = (attacker.atk * skill.power) / 50;
        baseDmg = (baseDmg / 5) * damageMult;
        let actualDmg = Math.floor(baseDmg * (0.8 + Math.random()*0.4) * finalDmgMult);
        
        // Mitigation
        let mitigated = Math.max(1, Math.floor(actualDmg * (100 / (100 + defender.def))));
        defender.hp = Math.max(0, defender.hp - mitigated);
        
        result.damage = mitigated;
        result.effectiveness = effort;
    }

    result.hp = {
        [attackerId]: attacker.hp,
        [defenderId]: defender.hp
    };

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
        if (room.players[otherId].isAI && accept) {
            // AI always accepts
            createRoom(socket, room.players[otherId]);
            return;
        }

        if (room.decision[p1Id] && room.decision[p2Id]) {
            createRoom(room.players[p1Id].socket, room.players[p2Id].socket);
        }
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
