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
    
    // Support either single type or array
    const types = Array.isArray(defenderTypes) ? defenderTypes : [defenderTypes];
    
    for (let t of types) {
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

// ====== BATTLE LOGIC (Authoritative Server) ======
function startBattle(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.state = "battle";
    room.currentTurnPlayerId = null;
    room.turnCount = 0;

    // STEP 2 – INITIALIZE STATS
    // Initial STAMINA ＝ 30 ＋ ポケモンのスタミナ／１５ (using spd or def if stamina null)
    room.playerIds.forEach(pid => {
        const f = room.fighters[pid];
        const baseStamina = f.stamina || f.spd || 50; 
        f.stamina = 30 + (baseStamina / 15);
        f.maxStamina = 100; // Visual limit
    });

    const p1Id = room.playerIds[0];
    const p2Id = room.playerIds[1];

    // Server -> Clients: battle_init
    io.to(roomId).emit("battle_init", {
        player: room.fighters[p1Id],
        opponent: room.fighters[p2Id]
    });

    // STEP 3 – DETERMINE TURN ORDER
    setTimeout(() => nextTurn(roomId), 1500);
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room || room.state !== "battle") return;

    const p1Id = room.playerIds[0];
    const p2Id = room.playerIds[1];
    const f1 = room.fighters[p1Id];
    const f2 = room.fighters[p2Id];

    if (!room.currentTurnPlayerId) {
        // Higher SPEED goes first
        if (f1.spd > f2.spd) room.currentTurnPlayerId = p1Id;
        else if (f2.spd > f1.spd) room.currentTurnPlayerId = p2Id;
        else room.currentTurnPlayerId = Math.random() < 0.5 ? p1Id : p2Id;
    } else {
        // Switch turn
        room.currentTurnPlayerId = (room.currentTurnPlayerId === p1Id) ? p2Id : p1Id;
    }

    const activeId = room.currentTurnPlayerId;
    const activeFighter = room.fighters[activeId];

    // Every 2 actions (1 turn) -> Stamina Regen (10 + stat / 10)
    if (room.turnCount > 0 && room.turnCount % 2 === 0) {
        room.playerIds.forEach(pid => {
            const f = room.fighters[pid];
            const baseStamina = f.stamina_stat || f.spd || 50;
            const regen = 10 + (baseStamina / 10);
            f.stamina = Math.min(100, f.stamina + regen);
        });
    }

    console.log(`Step 3/7: Turn Start. Player:${activeId}, Room:${roomId}`);

    // Server -> Clients: turn_start
    io.to(roomId).emit("turn_start", {
        currentTurnPlayerId: activeId,
        fighters: room.fighters // Sync for safety
    });

    // AI or Human handling
    const activePlayer = room.players[activeId];
    if (activePlayer.isAI) {
        setTimeout(() => {
            const skill = chooseSkillServer(activeFighter, room.fighters[activeId === p1Id ? p2Id : p1Id]);
            processSkillUse(roomId, activeId, skill.id);
        }, 1200);
    } else {
        activePlayer.socket.emit("request_action");
    }
}

function processSkillUse(roomId, playerId, skillId, skillName, stats) {
    const room = rooms[roomId];
    if (!room || room.state !== "battle" || room.currentTurnPlayerId !== playerId) return;
    clearTimeout(room.actionTimeout);

    const attacker = room.fighters[playerId];
    const defenderId = room.playerIds.find(id => id !== playerId);
    
    // Synchronize stats if provided by client (First turn only or as update)
    if (stats && room.turnCount === 0) {
        attacker.atk = stats.atk || attacker.atk;
        attacker.def = stats.def || attacker.def;
        attacker.spd = stats.spd || attacker.spd;
        attacker.hp = stats.hp || attacker.hp;
        attacker.maxHp = stats.maxHp || attacker.maxHp;
    }

    // Use pokemon's specific skill data if available
    const skill = attacker.skills[skillId] || Skills[skillId]; 

    if (!skill) {
        console.error(`Skill ID ${skillId} not found for player ${playerId}`);
        return;
    }

    // Stamina check
    const cost = getStaminaCost(skill);
    if (attacker.stamina < cost) {
        // Fallback to tackle if not enough stamina
        processSkillUse(roomId, playerId, 'tackle');
        return;
    }

    attacker.stamina -= cost;
    executeAction(roomId, playerId, defenderId, skillId, skillName || skill.name);
}

function getStaminaCost(skill) {
    if (skill.type === 'attack') return Math.round(skill.power * 0.3);
    return 10; // heal/buff
}

async function executeAction(roomId, attackerId, defenderId, skillId, skillNameOverride) {
    const room = rooms[roomId];
    if (!room) return;

    const attacker = room.fighters[attackerId];
    const defender = room.fighters[defenderId];
    const skill = attacker.skills[skillId] || Skills[skillId] || { name: skillNameOverride || 'Unknown', type: 'attack', power: 40 };

    room.turnCount++;
    // STEP 5 – SCALING RULE: Every 2 actions (1 round)
    const roundCount = Math.floor((room.turnCount - 1) / 2);
    const damageMult = 1.0 + (roundCount * 0.05); // Damage +5%
    const healDecay = 1.0 - (roundCount * 0.05); // Healing -5% (implied)

    attacker.isProtecting = false;

    let dmg = 0;
    let healAmount = 0;
    let effectiveness = getEffectiveness(skill.element, defender.types);

    if (skill.type === 'heal') {
        // Minimum heal = 15 HP
        const baseHeal = Math.floor(attacker.maxHp * 0.3 * healDecay);
        healAmount = Math.max(15, baseHeal);
        const oldHp = attacker.hp;
        attacker.hp = Math.min(attacker.maxHp, attacker.hp + healAmount);
        healAmount = attacker.hp - oldHp;
    } else if (skill.type === 'buff') {
        attacker.isProtecting = true;
    } else {
        // Attack!
        let baseDmg = (attacker.atk * (skill.power || 40)) / 50;
        baseDmg = (baseDmg / 5) * damageMult; 
        
        let finalDmgMult = effectiveness;
        if (defender.isProtecting) {
            finalDmgMult *= 0.5;
            defender.isProtecting = false; // Consume protection
        }

        let rawDmg = baseDmg * (0.8 + Math.random() * 0.4) * finalDmgMult;
        dmg = Math.max(1, Math.floor(rawDmg * (100 / (100 + defender.def))));
        defender.hp = Math.max(0, defender.hp - dmg);
    }

    // STEP 6 – SERVER RESPONSE (SYNC BOTH CLIENTS)
    
    // To Attacker
    const attackerPlayer = room.players[attackerId];
    if (attackerPlayer && !attackerPlayer.isAI) {
        attackerPlayer.socket.emit("action_result_self", {
            stamina: attacker.stamina,
            opponentHP: defender.hp,
            damage: dmg,
            heal: healAmount,
            skillName: skillNameOverride || skill.name,
            canAct: false
        });
    }

    // To Defender
    const defenderPlayer = room.players[defenderId];
    if (defenderPlayer && !defenderPlayer.isAI) {
        defenderPlayer.socket.emit("action_result_opponent", {
            remainingHP: defender.hp,
            attackerHP: attacker.hp, // added for sync
            damage: dmg,
            heal: healAmount,
            skillName: skillNameOverride || skill.name,
            skillId: skillId // to trigger correct animation
        });
    }

    // STEP 7 – SWITCH TURN
    if (defender.hp <= 0) {
        room.state = "finished";
        setTimeout(() => {
            // STEP 8 – GAME END
            io.to(roomId).emit("battle_end", {
                winnerId: attackerId,
                winnerPokemonName: attacker.name
            });
        }, 1500);
    } else {
        // Switch turn after animation pause
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
                const aiId = room.playerIds.find(id => id !== socket.id); // AI's ID
                
                // Select 4 unique random skills for AI
                const allSkillIds = Object.keys(Skills);
                const aiSkills = {};
                let pool = [...allSkillIds];
                for(let i=0; i<4 && pool.length > 0; i++) {
                    const idx = Math.floor(Math.random() * pool.length);
                    const randomId = pool.splice(idx, 1)[0];
                    aiSkills[randomId] = { id: randomId, ...Skills[randomId] };
                }

                room.fighters[aiId] = {
                    id: aiId,
                    name: "AI トレーナー",
                    maxHp: 200, hp: 200, atk: 55, def: 45, spd: 45,
                    spriteKey: 'pikachu', 
                    uiSpriteUrl: 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/25.png',
                    types: ['electric'],
                    skills: aiSkills,
                    isProtecting: false
                };
            }
            checkSelectionComplete(roomId);
        }
    });

    // Handle both old and new event names for compatibility
    socket.on("request_rematch", (data) => {
        socket.emit("retry_decision", { ...data, accept: true });
    });

    socket.on("retry_decision", ({ roomId, accept }) => {
        const room = rooms[roomId];
        if (!room) return;
        
        if (!room.decision) room.decision = {};
        room.decision[socket.id] = accept;
        
        const otherId = room.playerIds.find(id => id !== socket.id);
        const otherPlayer = room.players[otherId];

        if (!accept) {
            if (otherPlayer && !otherPlayer.isAI) otherPlayer.socket.emit("retry_declined");
            return;
        }

        // Check if both or AI
        if (otherPlayer && otherPlayer.isAI) {
            // Restart with same AI
            const p1 = room.players[socket.id].socket;
            createRoom(p1, otherPlayer);
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
        const { roomId, skillId, skillName, stats } = data;
        processSkillUse(roomId, socket.id, skillId, skillName, stats);
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
