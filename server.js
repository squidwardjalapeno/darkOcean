// server.js
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const http = createServer(app);
const io = new Server(http, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

const SECTOR_SIZE = 800;
const MAP_SECTORS = 10;
const SCOUT_TIME_MS = 30000;
const SERVER_BOOT_TIME = Date.now();

const ISLAND_TIERS = {
    1: { name: "Sandbar",           points: 1,     maxPop: 150,   growth: 0.5, defense: 1.0,  range: 500,  speed: 22 },
    2: { name: "Reef Haven",        points: 5,     maxPop: 400,   growth: 1.2, defense: 1.15, range: 850,  speed: 25 },
    3: { name: "Fertile Isle",      points: 25,    maxPop: 1000,  growth: 2.2, defense: 1.35, range: 1400, speed: 28 },
    4: { name: "Fortified Cay",     points: 125,   maxPop: 2200,  growth: 4.0, defense: 1.60, range: 2200, speed: 32 },
    5: { name: "Naval Base",        points: 500,   maxPop: 4500,  growth: 7.0, defense: 1.90, range: 3400, speed: 36 },
    6: { name: "Volcanic Citadel",  points: 2500,  maxPop: 9000,  growth: 12.0,defense: 2.30, range: 5500, speed: 42 },
    7: { name: "Ancient Leviathan", points: 12500, maxPop: 20000, growth: 20.0,defense: 2.80, range: 9000, speed: 48 }
};

const MINE_TIERS = {
    1: { name: "Gold Reef",      points: 2,   maxPop: 180,  growth: 0.4, maxGold: 400,   goldGrowth: 1.5, defense: 1.0,  range: 550,  speed: 22 },
    2: { name: "Pike Vein",      points: 10,  maxPop: 420,  growth: 0.9, maxGold: 1000,  goldGrowth: 2.5, defense: 1.1,  range: 950,  speed: 25 },
    3: { name: "Gilded Atoll",   points: 40,  maxPop: 900,  growth: 1.8, maxGold: 2500,  goldGrowth: 5.0, defense: 1.25, range: 1600, speed: 28 },
    4: { name: "Sunken Vault",   points: 180, maxPop: 1800, growth: 3.2, maxGold: 6000,  goldGrowth: 10.0,defense: 1.45, range: 2600, speed: 32 },
    5: { name: "El Dorado Core", points: 750, maxPop: 3500, growth: 5.5, maxGold: 12000, goldGrowth: 20.0,defense: 1.75, range: 4200, speed: 36 }
};

function pseudoRandom(seed) {
    let s = seed | 0;
    return function() {
        s = (Math.imul(s, 1664525) + 1013904223) | 0;
        return (s >>> 0) / 4294967296;
    };
}

function rollIslandLevel(rng) {
    const roll = rng();
    if (roll < 0.000064) return 7;
    if (roll < 0.0004) return 6;
    if (roll < 0.0025) return 5;
    if (roll < 0.015) return 4;
    if (roll < 0.08) return 3;
    if (roll < 0.32) return 2;
    return 1;
}

function formatIslandForClient(isle) {
    return {
        ...isle,
        population: Math.floor(isle.population),
        gold: Math.floor(isle.gold)
    };
}

// Global Persistence Registries
const playerSessions = new Map(); // token -> { token, playerId, name, socketId, lobbyId, gameId }
const lobbies = new Map();        // lobbyId -> lobby
const games = new Map();          // gameId -> game

class GameSession {
    constructor(id, players) {
        this.id = id;
        this.players = players;
        this.sectors = new Map();
        this.allIslands = new Map();
        this.activeVoyages = new Map();
        this.totalWorldPoints = 0;
        this.gameOver = false;
        this.winner = null;
        this.playerStates = new Map();

        this.initWorld();
    }

    initWorld() {
        const matchSeed = (Math.random() * 0x7FFFFFFF) | 0;

        for (let sx = 0; sx < MAP_SECTORS; sx++) {
            for (let sy = 0; sy < MAP_SECTORS; sy++) {
                const sKey = `${sx}_${sy}`;
                const sectorSeed = (matchSeed ^ (sx * 73856093) ^ (sy * 19349663)) | 0;
                const rng = pseudoRandom(sectorSeed);
                const count = 3 + Math.floor(rng() * 3);
                const sectorIslands = [];

                for (let i = 0; i < count; i++) {
                    const isMine = rng() < 0.12;
                    const level = rollIslandLevel(rng);
                    const padding = 130;
                    const localX = padding + Math.floor(rng() * (SECTOR_SIZE - padding * 2));
                    const localY = padding + Math.floor(rng() * (SECTOR_SIZE - padding * 2));
                    const isleId = `isle_${this.id}_${sx}_${sy}_${i}`;

                    let isle;
                    if (isMine) {
                        const mLevel = Math.min(5, level);
                        const t = MINE_TIERS[mLevel];
                        isle = {
                            id: isleId, sx, sy,
                            x: (sx * SECTOR_SIZE) + localX,
                            y: (sy * SECTOR_SIZE) + localY,
                            type: 'MINE',
                            level: mLevel,
                            points: t.points,
                            name: `${t.name} [${sx}:${sy}]`,
                            population: Math.max(10, Math.floor(t.maxPop * 0.20)),
                            maxPop: t.maxPop,
                            growth: t.growth,
                            gold: 35,
                            maxGold: t.maxGold,
                            goldGrowth: t.goldGrowth,
                            defense: t.defense,
                            range: t.range,
                            speed: t.speed,
                            owner: null,
                            upgrades: { speed: 0, range: 0, defense: 0 }
                        };
                    } else {
                        const t = ISLAND_TIERS[level];
                        isle = {
                            id: isleId, sx, sy,
                            x: (sx * SECTOR_SIZE) + localX,
                            y: (sy * SECTOR_SIZE) + localY,
                            type: 'NORMAL',
                            level,
                            points: t.points,
                            name: `${t.name} [${sx}:${sy}]`,
                            population: Math.max(12, Math.floor(t.maxPop * 0.22)),
                            maxPop: t.maxPop,
                            growth: t.growth,
                            gold: 0,
                            maxGold: 150 * level,
                            goldGrowth: 0,
                            defense: t.defense,
                            range: t.range,
                            speed: t.speed,
                            owner: null,
                            upgrades: { speed: 0, range: 0, defense: 0 }
                        };
                    }

                    this.totalWorldPoints += isle.points;
                    sectorIslands.push(isle);
                    this.allIslands.set(isleId, isle);
                }
                this.sectors.set(sKey, sectorIslands);
            }
        }

        let spawnA, spawnB, dist;
        do {
            spawnA = { sx: Math.floor(Math.random() * MAP_SECTORS), sy: Math.floor(Math.random() * MAP_SECTORS) };
            spawnB = { sx: Math.floor(Math.random() * MAP_SECTORS), sy: Math.floor(Math.random() * MAP_SECTORS) };
            dist = Math.hypot(spawnA.sx - spawnB.sx, spawnA.sy - spawnB.sy);
        } while (dist < 4.5);

        const spawns = [spawnA, spawnB];

        this.players.forEach((p, idx) => {
            const sp = spawns[idx];
            const secKey = `${sp.sx}_${sp.sy}`;
            const sIslands = this.sectors.get(secKey);
            const homeIsle = sIslands[0];

            homeIsle.owner = p.id;
            homeIsle.type = 'NORMAL';
            homeIsle.level = 2;
            homeIsle.points = ISLAND_TIERS[2].points;
            homeIsle.name = `Home Port [${sp.sx}:${sp.sy}]`;
            homeIsle.maxPop = ISLAND_TIERS[2].maxPop;
            homeIsle.range = ISLAND_TIERS[2].range;
            homeIsle.growth = ISLAND_TIERS[2].growth;
            homeIsle.defense = ISLAND_TIERS[2].defense;
            homeIsle.speed = ISLAND_TIERS[2].speed;
            homeIsle.population = 250;
            homeIsle.gold = 75;
            homeIsle.goldGrowth = 0;

            this.playerStates.set(p.id, {
                id: p.id,
                name: p.name,
                homeSector: { sx: sp.sx, sy: sp.sy },
                autoScout: false,
                discoveredSectors: new Set([secKey]),
                scout: {
                    state: 'IDLE',
                    currentSector: { sx: sp.sx, sy: sp.sy },
                    targetSector: null,
                    startTime: 0,
                    duration: SCOUT_TIME_MS
                }
            });
        });
    }

    start() {
        this.players.forEach(p => {
            const pState = this.playerStates.get(p.id);
            const revealed = Array.from(pState.discoveredSectors).map(key => {
                const [sx, sy] = key.split('_').map(Number);
                const isles = this.sectors.get(key) || [];
                return { key, sx, sy, islands: isles.map(formatIslandForClient) };
            });

            io.to(p.id).emit('gameStarted', {
                gameId: this.id,
                myId: p.id,
                sectorSize: SECTOR_SIZE,
                mapSectors: MAP_SECTORS,
                scoutTimeMs: SCOUT_TIME_MS,
                players: this.players.map(pl => ({ id: pl.id, name: pl.name })),
                revealedSectors: revealed,
                scout: pState.scout,
                totalWorldPoints: this.totalWorldPoints
            });
        });
    }

    checkWinCondition() {
        if (this.gameOver) return;

        const scores = {};
        this.players.forEach(p => scores[p.id] = 0);

        for (const [id, isle] of this.allIslands) {
            if (isle.owner && scores[isle.owner] !== undefined) {
                scores[isle.owner] += isle.points;
            }
        }

        for (const p of this.players) {
            const score = scores[p.id];
            const pct = (score / this.totalWorldPoints) * 100;

            if (pct > 50) {
                this.gameOver = true;
                this.winner = { id: p.id, name: p.name, score, pct: pct.toFixed(1) };
                io.to(this.id).emit('gameOver', this.winner);

                this.players.forEach(pl => {
                    for (const [tok, sess] of playerSessions) {
                        if (sess.playerId === pl.id) sess.gameId = null;
                    }
                });
                break;
            }
        }
    }
}

function findNextAutoScoutSector(playerState) {
    const visited = new Set(playerState.discoveredSectors);
    const candidateSectors = [];
    const home = playerState.homeSector;

    for (const chartedKey of playerState.discoveredSectors) {
        const [cx, cy] = chartedKey.split('_').map(Number);
        const neighbors = [
            { sx: cx, sy: cy - 1 },
            { sx: cx + 1, sy: cy },
            { sx: cx, sy: cy + 1 },
            { sx: cx - 1, sy: cy }
        ];

        for (const n of neighbors) {
            if (n.sx < 0 || n.sx >= MAP_SECTORS || n.sy < 0 || n.sy >= MAP_SECTORS) continue;
            const nKey = `${n.sx}_${n.sy}`;

            if (!visited.has(nKey)) {
                visited.add(nKey);
                const distFromHome = Math.hypot(n.sx - home.sx, n.sy - home.sy);
                let angle = Math.atan2(n.sy - home.sy, n.sx - home.sx);
                if (angle < 0) angle += Math.PI * 2;

                candidateSectors.push({ ...n, dist: distFromHome, angle });
            }
        }
    }

    if (candidateSectors.length === 0) return null;
    candidateSectors.sort((a, b) => a.dist - b.dist || a.angle - b.angle);
    return candidateSectors[0];
}

// Socket Connection Lifecycle & Session Authentication
io.on('connection', (socket) => {
    let playerSession = null;

    socket.on('authenticate', ({ token, name }) => {
        // Use client's persistent token, or issue one if totally absent
        const safeToken = token || `tok_${Math.random().toString(36).substr(2, 9)}_${SERVER_BOOT_TIME}`;
        const cleanName = name ? name.slice(0, 4).toUpperCase() : null;

        if (playerSessions.has(safeToken)) {
            // Existing session found in RAM
            playerSession = playerSessions.get(safeToken);
            playerSession.socketId = socket.id;
            if (cleanName && !playerSession.name) playerSession.name = cleanName;
        } else {
            // Brand-new player connection
            const playerId = `usr_${Math.random().toString(36).substr(2, 6)}`;
            playerSession = {
                token: safeToken,
                playerId,
                name: cleanName,
                socketId: socket.id,
                lobbyId: null,
                gameId: null
            };
            playerSessions.set(safeToken, playerSession);
        }

        socket.data.token = safeToken;
        socket.data.playerId = playerSession.playerId;
        socket.join(playerSession.playerId);

        // RECONNECT TO ACTIVE RUNNING MATCH
        if (playerSession.gameId && games.has(playerSession.gameId)) {
            const game = games.get(playerSession.gameId);
            if (!game.gameOver) {
                socket.join(game.id);

                // Notify opponent that we are back online!
                io.to(game.id).emit('playerConnectionState', {
                    playerId: playerSession.playerId,
                    connected: true
                });

                const pState = game.playerStates.get(playerSession.playerId);
                const revealed = Array.from(pState.discoveredSectors).map(key => {
                    const [sx, sy] = key.split('_').map(Number);
                    const isles = game.sectors.get(key) || [];
                    return { key, sx, sy, islands: isles.map(formatIslandForClient) };
                });

                socket.emit('gameReconnected', {
                    token: safeToken,
                    gameId: game.id,
                    myId: playerSession.playerId,
                    name: playerSession.name,
                    sectorSize: SECTOR_SIZE,
                    mapSectors: MAP_SECTORS,
                    scoutTimeMs: SCOUT_TIME_MS,
                    players: game.players.map(pl => ({ id: pl.id, name: pl.name })),
                    revealedSectors: revealed,
                    scout: pState.scout,
                    autoScout: pState.autoScout,
                    totalWorldPoints: game.totalWorldPoints,
                    activeVoyages: Array.from(game.activeVoyages.values())
                });
                return;
            }
        }

        // Standard auth confirmation for menus / lobbies
        socket.emit('authConfirmed', {
            token: safeToken,
            serverBootTime: SERVER_BOOT_TIME,
            hasName: !!playerSession.name,
            name: playerSession.name,
            playerId: playerSession.playerId
        });
    });

    socket.on('setPlayerName', (name) => {
        if (!playerSession) return;
        playerSession.name = (name || "CAPT").slice(0, 4).toUpperCase();
        socket.emit('nameConfirmed', playerSession.name);
    });

    socket.on('getLobbies', () => {
        const list = [];
        for (const [id, lobby] of lobbies) {
            if (!lobby.started) {
                list.push({
                    id,
                    host: lobby.players[0].name,
                    playerCount: lobby.players.length
                });
            }
        }
        socket.emit('lobbyList', list);
    });

    socket.on('createLobby', () => {
        if (!playerSession) return;

        const lobbyId = `LOBBY_${Math.random().toString(36).substr(2, 5).toUpperCase()}`;
        const lobby = {
            id: lobbyId,
            hostId: playerSession.playerId,
            players: [{ id: playerSession.playerId, name: playerSession.name }],
            started: false
        };

        lobbies.set(lobbyId, lobby);
        playerSession.lobbyId = lobbyId;
        socket.join(lobbyId);

        socket.emit('lobbyState', {
            lobbyId,
            host: playerSession.name,
            isHost: true,
            players: lobby.players.map(p => p.name)
        });
        io.emit('lobbyUpdated');
    });

    socket.on('joinLobby', (lobbyId) => {
        if (!playerSession) return;
        const lobby = lobbies.get(lobbyId);

        if (!lobby || lobby.started) {
            socket.emit('lobbyError', 'Sector is expired or closed.');
            return;
        }

        if (lobby.players.some(p => p.id === playerSession.playerId)) {
            socket.emit('lobbyError', 'You are already docked in this sector.');
            return;
        }

        if (lobby.players.length >= 2) {
            socket.emit('lobbyError', 'Sector frequency is full (2/2).');
            return;
        }

        lobby.players.push({ id: playerSession.playerId, name: playerSession.name });
        playerSession.lobbyId = lobbyId;
        socket.join(lobbyId);

        io.to(lobbyId).emit('lobbyState', {
            lobbyId: lobby.id,
            host: lobby.players[0].name,
            isHost: false,
            players: lobby.players.map(p => p.name)
        });

        io.emit('lobbyUpdated');
    });

    socket.on('requestStartGame', () => {
        if (!playerSession || !playerSession.lobbyId) return;
        const lobby = lobbies.get(playerSession.lobbyId);
        if (!lobby) return;

        if (lobby.players.length < 2) {
            socket.emit('lobbyError', 'Cannot launch: 2 commanders required (1/2 docked).');
            return;
        }

        if (lobby.started) return;
        lobby.started = true;

        const game = new GameSession(lobby.id, lobby.players);
        games.set(lobby.id, game);

        lobby.players.forEach(p => {
            for (const [tok, sess] of playerSessions) {
                if (sess.playerId === p.id) {
                    sess.gameId = lobby.id;
                    sess.lobbyId = null;
                }
            }
        });

        io.emit('lobbyUpdated');
        game.start();
    });

    socket.on('sendVoyage', (data) => {
        if (!playerSession || !playerSession.gameId) return;
        const game = games.get(playerSession.gameId);
        if (!game || game.gameOver) return;

        const from = game.allIslands.get(data.fromId);
        const to = game.allIslands.get(data.toId);
        if (!from || !to || from.owner !== playerSession.playerId || from.id === to.id) return;

        const ratio = Math.max(0.1, Math.min(0.95, data.percentage || 0.5));
        const troopsSent = Math.floor(from.population * ratio);
        if (troopsSent < 1) return;

        const goldSentRatio = Math.max(0, Math.min(1.0, data.goldRatio || 0));
        const goldSent = Math.floor((from.gold || 0) * goldSentRatio);

        from.population -= troopsSent;
        from.gold -= goldSent;

        io.to(game.id).emit('islandUpdated', {
            id: from.id,
            population: Math.floor(from.population),
            gold: Math.floor(from.gold),
            owner: from.owner
        });

        const dist = Math.hypot(to.x - from.x, to.y - from.y);
        const decay = Math.pow(2, -(dist / from.range));
        const effectiveTroops = Math.max(1, Math.floor(troopsSent * decay));
        const duration = Math.max(2500, (dist / (from.speed || 24)) * 1000);

        const voyageId = `v_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
        const voyage = {
            id: voyageId,
            owner: playerSession.playerId,
            playerName: playerSession.name,
            fromId: from.id,
            toId: to.id,
            targetOwner: to.owner,
            startX: from.x,
            startY: from.y,
            targetX: to.x,
            targetY: to.y,
            targetName: to.name,
            departedPop: troopsSent,
            effectivePop: effectiveTroops,
            goldPayload: goldSent,
            startTime: Date.now(),
            duration,
            arrivalTime: Date.now() + duration
        };

        game.activeVoyages.set(voyageId, voyage);
        io.to(game.id).emit('voyageLaunched', voyage);
    });

    socket.on('dispatchScout', (target) => {
        if (!playerSession || !playerSession.gameId) return;
        const game = games.get(playerSession.gameId);
        if (!game || game.gameOver) return;

        const pState = game.playerStates.get(playerSession.playerId);
        if (!pState || pState.scout.state === 'CHARTING') return;

        const { sx, sy } = target;
        if (sx < 0 || sx >= MAP_SECTORS || sy < 0 || sy >= MAP_SECTORS) return;

        pState.scout.state = 'CHARTING';
        pState.scout.targetSector = { sx, sy };
        pState.scout.startTime = Date.now();
        pState.scout.duration = SCOUT_TIME_MS;

        io.to(playerSession.playerId).emit('scoutUpdate', pState.scout);
    });

    socket.on('toggleAutoScout', (enabled) => {
        if (!playerSession || !playerSession.gameId) return;
        const game = games.get(playerSession.gameId);
        if (!game) return;

        const pState = game.playerStates.get(playerSession.playerId);
        if (pState) {
            pState.autoScout = enabled;
            io.to(playerSession.playerId).emit('autoScoutState', pState.autoScout);
        }
    });

    socket.on('upgradeIsland', (data) => {
        if (!playerSession || !playerSession.gameId) return;
        const game = games.get(playerSession.gameId);
        if (!game || game.gameOver) return;

        const isle = game.allIslands.get(data.islandId);
        if (!isle || isle.owner !== playerSession.playerId) return;

        const upgradeType = data.type;
        const currentLvl = isle.upgrades[upgradeType] || 0;
        if (currentLvl >= 5) return;

        const cost = Math.floor(50 * Math.pow(2, currentLvl) * Math.pow(2, isle.level - 1));
        if (isle.gold < cost) return;

        isle.gold -= cost;
        isle.upgrades[upgradeType] = currentLvl + 1;

        if (upgradeType === 'speed') isle.speed = Math.round(isle.speed * 1.15);
        if (upgradeType === 'range') isle.range = Math.round(isle.range * 1.20);
        if (upgradeType === 'defense') isle.defense = Number((isle.defense + 0.25).toFixed(2));

        io.to(game.id).emit('islandUpgraded', {
            id: isle.id,
            gold: Math.floor(isle.gold),
            speed: isle.speed,
            range: isle.range,
            defense: isle.defense,
            upgrades: isle.upgrades
        });
    });

    socket.on('disconnect', () => {
        if (!playerSession) return;

        if (playerSession.lobbyId && lobbies.has(playerSession.lobbyId)) {
            const lobby = lobbies.get(playerSession.lobbyId);
            lobby.players = lobby.players.filter(p => p.id !== playerSession.playerId);

            if (lobby.players.length === 0) {
                lobbies.delete(playerSession.lobbyId);
            } else {
                io.to(playerSession.lobbyId).emit('lobbyState', {
                    lobbyId: lobby.id,
                    host: lobby.players[0].name,
                    players: lobby.players.map(p => p.name)
                });
            }
            playerSession.lobbyId = null;
            io.emit('lobbyUpdated');
        }

        if (playerSession.gameId && games.has(playerSession.gameId)) {
            io.to(playerSession.gameId).emit('playerConnectionState', {
                playerId: playerSession.playerId,
                connected: false
            });
        }
    });
});

// 20Hz Tick: Scouts and Voyages
setInterval(() => {
    const now = Date.now();

    for (const [gId, game] of games) {
        if (game.gameOver) continue;

        for (const [playerId, pState] of game.playerStates) {
            const scout = pState.scout;

            if (scout.state === 'CHARTING' && now >= (scout.startTime + scout.duration)) {
                const { sx, sy } = scout.targetSector;
                const sectorKey = `${sx}_${sy}`;

                pState.discoveredSectors.add(sectorKey);
                const discovered = game.sectors.get(sectorKey) || [];

                scout.state = 'IDLE';
                scout.currentSector = { sx, sy };
                scout.targetSector = null;

                io.to(playerId).emit('sectorCharted', {
                    sector: { 
                        key: sectorKey, 
                        sx, 
                        sy, 
                        islands: discovered.map(formatIslandForClient) 
                    },
                    scout
                });
            }

            if (pState.autoScout && scout.state === 'IDLE') {
                const nextTarget = findNextAutoScoutSector(pState);
                if (nextTarget) {
                    scout.state = 'CHARTING';
                    scout.targetSector = { sx: nextTarget.sx, sy: nextTarget.sy };
                    scout.startTime = now;
                    scout.duration = SCOUT_TIME_MS;
                    io.to(playerId).emit('scoutUpdate', scout);
                }
            }
        }

        for (const [vId, v] of game.activeVoyages) {
            if (now >= v.arrivalTime) {
                resolveVoyageArrival(game, v);
                game.activeVoyages.delete(vId);
                io.to(gId).emit('voyageArrived', { id: vId, toId: v.toId });
                game.checkWinCondition();
            }
        }
    }
}, 50);

// 1Hz Tick: Continuous S-Curve Population Growth & Gold
setInterval(() => {
    for (const [gId, game] of games) {
        if (game.gameOver) continue;

        for (const [id, isle] of game.allIslands) {
            if (isle.owner) {
                const ratio = Math.max(0.01, isle.population / isle.maxPop);
                if (ratio < 1.0) {
                    const logisticFactor = Math.max(0.08, 4 * ratio * (1 - ratio));
                    const popGain = isle.growth * logisticFactor;
                    isle.population = Math.min(isle.maxPop, Number((isle.population + popGain).toFixed(3)));
                }
            }

            if (isle.goldGrowth > 0 && isle.gold < isle.maxGold) {
                isle.gold = Math.min(isle.maxGold, Number((isle.gold + isle.goldGrowth).toFixed(2)));
            }
        }

        const syncedIslands = Array.from(game.allIslands.values()).map(formatIslandForClient);
        io.to(gId).emit('islandsSync', syncedIslands);
        game.checkWinCondition();
    }
}, 1000);

function resolveVoyageArrival(game, v) {
    const target = game.allIslands.get(v.toId);
    if (!target) return;

    if (target.owner === v.owner) {
        target.population = Math.min(target.maxPop, target.population + v.effectivePop);
        target.gold = Math.min(target.maxGold, target.gold + (v.goldPayload || 0));
    } else {
        const effectiveDamage = Math.max(1, Math.floor(v.effectivePop / target.defense));

        if (effectiveDamage >= target.population) {
            target.owner = v.owner;
            target.population = Math.max(1, Math.floor(effectiveDamage - target.population));
            target.gold = Math.min(target.maxGold, target.gold + (v.goldPayload || 0));
        } else {
            target.population -= effectiveDamage;
        }
    }

    io.to(game.id).emit('islandUpdated', {
        id: target.id,
        population: Math.floor(target.population),
        gold: Math.floor(target.gold),
        owner: target.owner
    });
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, '0.0.0.0', () => {
    console.log(`🌊 Dark Ocean Server running on port ${PORT}`);
});