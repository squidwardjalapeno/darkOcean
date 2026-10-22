// public/client.js
// public/client.js (Replace top session setup and auth listeners)
const socket = io();
const canvas = document.getElementById('viewport');
const ctx = canvas.getContext('2d');
const viewportContainer = document.getElementById('viewport-container');

// Session Persistence
let myToken = localStorage.getItem('dark_ocean_token');
if (!myToken) {
    myToken = `tok_${Math.random().toString(36).substr(2, 9)}_${Date.now().toString(36)}`;
    localStorage.setItem('dark_ocean_token', myToken);
}

let myId = null;
let myName = "";
let enemyId = null;
let enemyName = "ENEMY";
let totalWorldPoints = 1;
let SECTOR_SIZE = 800;
let MAP_SECTORS = 10;
let SCOUT_TIME_MS = 30000;

// Camera & Panning
let camera = { x: 400, y: 400, zoom: 0.75 };
const PAN_SPEED = 700;
const keysDown = new Set();
let lastTime = performance.now();

// --- ADD THESE KEYBOARD LISTENERS HERE ---
window.addEventListener('keydown', (e) => {
    // Prevent default window scrolling behavior when pressing arrows or spacebar
    if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) {
        e.preventDefault();
    }
    keysDown.add(e.code);
});

window.addEventListener('keyup', (e) => {
    keysDown.delete(e.code);
});
// ----------------------------------------



// Game State
const discoveredSectors = new Set();
const islandLookup = new Map();
const activeVoyages = new Map();
let scout = { state: 'IDLE', currentSector: { sx: 0, sy: 0 }, targetSector: null };
let autoScoutEnabled = false;

// Selection & Attack State
let selectedIslandId = null;
let sendTroopRatio = 0.50;
let sendGoldRatio = 0.0;
let isDraggingAttack = false;
let dragSourceId = null;
let dragCurrentPos = { x: 0, y: 0 };
let pointerDownPos = { x: 0, y: 0 };

// Touch tracking
let touchStartDist = 0;
let touchStartZoom = 0.75;
let isPanning = false;
let lastPanPos = { x: 0, y: 0 };

function getIslandRadius(isle) {
    const radii = [0, 5, 10, 20, 40, 80, 160, 320];
    return radii[isle.level] || 5;
}

function resize() {
    if (viewportContainer) {
        canvas.width = viewportContainer.clientWidth;
        canvas.height = viewportContainer.clientHeight;
    } else {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    }
}
window.addEventListener('resize', resize);
resize();

// ==========================================
// 1. AUTHENTICATION & RENDER RESTART SYNC
// ==========================================
const nameModal = document.getElementById('name-modal');
const lobbyModal = document.getElementById('lobby-modal');
const tacticalSidebar = document.getElementById('tactical-sidebar');
const nameInput = document.getElementById('player-name-input');
const submitNameBtn = document.getElementById('submit-name-btn');
const createLobbyBtn = document.getElementById('create-lobby-btn');
const refreshLobbiesBtn = document.getElementById('refresh-lobbies-btn');
const lobbyList = document.getElementById('lobby-list');
const displayCallsign = document.getElementById('display-callsign');
const lobbyErrorMsg = document.getElementById('lobby-error-msg');
const lobbyDirectoryView = document.getElementById('lobby-directory-view');
const lobbyRoomView = document.getElementById('lobby-room-view');
const slotP1 = document.getElementById('slot-p1');
const slotP2 = document.getElementById('slot-p2');
const launchMatchBtn = document.getElementById('launch-match-btn');

socket.on('connect', () => {
    const storedBootTime = localStorage.getItem('dark_ocean_boot_time');
    const storedName = localStorage.getItem('dark_ocean_name');
    socket.emit('authenticate', { 
        token: myToken, 
        name: storedName, 
        bootTime: storedBootTime ? Number(storedBootTime) : null 
    });
});

socket.on('authConfirmed', (data) => {
    myId = data.playerId;
    
    // Save current server boot time
    localStorage.setItem('dark_ocean_boot_time', data.serverBootTime);

    // If server wiped its memory (Render restart), force them to re-enter name!
    if (!data.hasName) {
        localStorage.removeItem('dark_ocean_name');
        nameModal.classList.remove('hidden');
        lobbyModal.classList.add('hidden');
    } else {
        myName = data.name;
        nameModal.classList.add('hidden');
        lobbyModal.classList.remove('hidden');
        displayCallsign.innerText = myName;
        socket.emit('getLobbies');
    }
});

// Seamless Reconnection to Active Running Match
socket.on('gameReconnected', (data) => {
    nameModal.classList.add('hidden');
    lobbyModal.classList.add('hidden');
    tacticalSidebar.classList.remove('hidden');
    resize();

    myId = data.myId;
    myName = data.name;
    SECTOR_SIZE = data.sectorSize;
    MAP_SECTORS = data.mapSectors;
    SCOUT_TIME_MS = data.scoutTimeMs;
    totalWorldPoints = data.totalWorldPoints;
    scout = data.scout;
    autoScoutEnabled = data.autoScout;

    const other = data.players.find(p => p.id !== myId);
    if (other) {
        enemyId = other.id;
        enemyName = other.name;
    }

    document.getElementById('hud-my-name').innerText = myName;
    document.getElementById('hud-enemy-name').innerText = enemyName;

    discoveredSectors.clear();
    islandLookup.clear();
    activeVoyages.clear();

    data.revealedSectors.forEach(sec => {
        discoveredSectors.add(sec.key);
        sec.islands.forEach(isle => islandLookup.set(isle.id, isle));
    });

    if (data.activeVoyages) {
        data.activeVoyages.forEach(v => activeVoyages.set(v.id, v));
    }

    const myHome = Array.from(islandLookup.values()).find(i => i.owner === myId);
    if (myHome) {
        camera.x = myHome.x;
        camera.y = myHome.y;
        selectIsland(myHome);
    }

    updateHUD();
    renderScores();
});

// Opponent connection status indicator
socket.on('playerConnectionState', (data) => {
    if (data.playerId === enemyId) {
        const enemyLabel = document.getElementById('hud-enemy-name');
        if (data.connected) {
            enemyLabel.innerText = enemyName;
            enemyLabel.style.color = "";
        } else {
            enemyLabel.innerText = `${enemyName} (OFFLINE)`;
            enemyLabel.style.color = "#f5b041";
        }
    }
});

submitNameBtn.onclick = () => {
    const val = nameInput.value.trim().slice(0, 4);
    if (!val) return;
    myName = val;
    localStorage.setItem('dark_ocean_name', myName);
    socket.emit('setPlayerName', myName);
};

nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNameBtn.click();
});

socket.on('nameConfirmed', (name) => {
    myName = name;
    localStorage.setItem('dark_ocean_name', myName);
    nameModal.classList.add('hidden');
    lobbyModal.classList.remove('hidden');
    displayCallsign.innerText = myName;
    socket.emit('getLobbies');
});

createLobbyBtn.onclick = () => {
    lobbyErrorMsg.classList.add('hidden');
    socket.emit('createLobby');
};

refreshLobbiesBtn.onclick = () => {
    lobbyErrorMsg.classList.add('hidden');
    socket.emit('getLobbies');
};

launchMatchBtn.onclick = () => {
    socket.emit('requestStartGame');
};

socket.on('lobbyError', (msg) => {
    lobbyErrorMsg.innerText = msg;
    lobbyErrorMsg.classList.remove('hidden');
});

socket.on('lobbyState', (data) => {
    lobbyErrorMsg.classList.add('hidden');
    createLobbyBtn.disabled = true;
    lobbyDirectoryView.classList.add('hidden');
    lobbyRoomView.classList.remove('hidden');

    slotP1.innerText = data.players[0] || 'AWAITING...';
    slotP2.innerText = data.players[1] || 'AWAITING OPPONENT...';
    slotP2.style.color = data.players[1] ? '#00ff77' : '#f5b041';

    if (data.players.length === 2) {
        launchMatchBtn.innerText = "LAUNCH MATCH [READY: 2/2]";
        launchMatchBtn.style.background = "#00ff77";
        launchMatchBtn.style.color = "#020710";
    } else {
        launchMatchBtn.innerText = "WAITING FOR OPPONENT [1/2]";
        launchMatchBtn.style.background = "#09213a";
        launchMatchBtn.style.color = "#d0e2f2";
    }
});

socket.on('lobbyUpdated', () => socket.emit('getLobbies'));

socket.on('lobbyList', (list) => {
    lobbyList.innerHTML = '';
    if (list.length === 0) {
        lobbyList.innerHTML = '<div style="padding: 12px; text-align: center; color: var(--text-dim); font-size: 11px;">No open sectors. Create one!</div>';
        return;
    }

    list.forEach(item => {
        const row = document.createElement('div');
        row.className = 'lobby-entry';
        row.innerHTML = `
            <div><strong>${item.host}'S SECTOR</strong> [${item.playerCount}/2]</div>
            <button class="action-btn" data-id="${item.id}" style="padding: 2px 8px;">DOCK</button>
        `;
        row.querySelector('button').onclick = () => socket.emit('joinLobby', item.id);
        lobbyList.appendChild(row);
    });
});

socket.on('gameStarted', (data) => {
    nameModal.classList.add('hidden');
    lobbyModal.classList.add('hidden');
    tacticalSidebar.classList.remove('hidden');
    resize();

    myId = data.myId;
    SECTOR_SIZE = data.sectorSize;
    MAP_SECTORS = data.mapSectors;
    SCOUT_TIME_MS = data.scoutTimeMs;
    totalWorldPoints = data.totalWorldPoints;
    scout = data.scout;

    const other = data.players.find(p => p.id !== myId);
    if (other) {
        enemyId = other.id;
        enemyName = other.name;
    }

    document.getElementById('hud-my-name').innerText = myName;
    document.getElementById('hud-enemy-name').innerText = enemyName;

    discoveredSectors.clear();
    islandLookup.clear();

    data.revealedSectors.forEach(sec => {
        discoveredSectors.add(sec.key);
        sec.islands.forEach(isle => islandLookup.set(isle.id, isle));
    });

    const myHome = Array.from(islandLookup.values()).find(i => i.owner === myId);
    if (myHome) {
        camera.x = myHome.x;
        camera.y = myHome.y;
        selectIsland(myHome);
    }

    updateHUD();
    renderScores();
});

// ==========================================
// 3. COORDINATES & HITBOXES
// ==========================================
function screenToWorld(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const sx = clientX - rect.left;
    const sy = clientY - rect.top;
    return {
        x: (sx - canvas.width / 2) / camera.zoom + camera.x,
        y: (sy - canvas.height / 2) / camera.zoom + camera.y
    };
}

function findIslandNear(wx, wy) {
    let closest = null;
    let minDist = Infinity;

    for (const [id, isle] of islandLookup) {
        const radius = getIslandRadius(isle);
        const hitRadius = Math.max(26, radius + 12);
        const dist = Math.hypot(isle.x - wx, isle.y - wy);

        if (dist <= hitRadius && dist < minDist) {
            minDist = dist;
            closest = isle;
        }
    }
    return closest;
}

function executeAttack(fromIslandId, toIslandId) {
    if (!fromIslandId || !toIslandId || fromIslandId === toIslandId) return;
    socket.emit('sendVoyage', {
        fromId: fromIslandId,
        toId: toIslandId,
        percentage: sendTroopRatio,
        goldRatio: sendGoldRatio
    });
}

function selectIsland(isle) {
    selectedIslandId = isle ? isle.id : null;
    if (isle) showArmory(isle);
    else showStandby();
}

// ==========================================
// 4. MOUSE & DRAG / CLICK-TO-ATTACK
// ==========================================
canvas.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    pointerDownPos = { x: e.clientX, y: e.clientY };
    const world = screenToWorld(e.clientX, e.clientY);
    const clicked = findIslandNear(world.x, world.y);

    if (clicked && clicked.owner === myId) {
        isDraggingAttack = true;
        dragSourceId = clicked.id;
        dragCurrentPos = world;
        selectIsland(clicked);
    } else {
        isPanning = true;
        lastPanPos = { x: e.clientX, y: e.clientY };
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDraggingAttack) {
        dragCurrentPos = screenToWorld(e.clientX, e.clientY);
    } else if (isPanning) {
        const dx = (e.clientX - lastPanPos.x) / camera.zoom;
        const dy = (e.clientY - lastPanPos.y) / camera.zoom;
        camera.x -= dx;
        camera.y -= dy;
        lastPanPos = { x: e.clientX, y: e.clientY };
    }
});

window.addEventListener('mouseup', (e) => {
    const moveDist = Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y);
    const world = screenToWorld(e.clientX, e.clientY);
    const target = findIslandNear(world.x, world.y);

    if (isDraggingAttack && dragSourceId) {
        if (target && target.id !== dragSourceId) {
            executeAttack(dragSourceId, target.id);
        }
        isDraggingAttack = false;
        dragSourceId = null;
        isPanning = false;
        return;
    }

    isPanning = false;

    if (moveDist < 8) {
        if (target) {
            if (target.owner === myId) {
                selectIsland(target);
            } else if (selectedIslandId) {
                executeAttack(selectedIslandId, target.id);
            } else {
                selectIsland(target);
            }
        } else {
            const sx = Math.floor(world.x / SECTOR_SIZE);
            const sy = Math.floor(world.y / SECTOR_SIZE);
            if (sx >= 0 && sx < MAP_SECTORS && sy >= 0 && sy < MAP_SECTORS) {
                const key = `${sx}_${sy}`;
                if (!discoveredSectors.has(key)) {
                    socket.emit('dispatchScout', { sx, sy });
                } else {
                    selectIsland(null);
                }
            }
        }
    }
});

canvas.addEventListener('wheel', (e) => {
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    camera.zoom = Math.max(0.12, Math.min(2.5, camera.zoom * factor));
});

// ==========================================
// 5. TOUCH & PINCH-ZOOM
// ==========================================
canvas.addEventListener('touchstart', (e) => {
    if (e.touches.length === 1) {
        const t = e.touches[0];
        pointerDownPos = { x: t.clientX, y: t.clientY };
        lastPanPos = { x: t.clientX, y: t.clientY };
        const world = screenToWorld(t.clientX, t.clientY);
        const clicked = findIslandNear(world.x, world.y);

        if (clicked && clicked.owner === myId) {
            isDraggingAttack = true;
            dragSourceId = clicked.id;
            dragCurrentPos = world;
            selectIsland(clicked);
        } else {
            isPanning = true;
        }
    } else if (e.touches.length === 2) {
        isDraggingAttack = false;
        isPanning = false;
        touchStartDist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        touchStartZoom = camera.zoom;
    }
}, { passive: false });

canvas.addEventListener('touchmove', (e) => {
    e.preventDefault();
    if (e.touches.length === 1) {
        const t = e.touches[0];
        if (isDraggingAttack) {
            dragCurrentPos = screenToWorld(t.clientX, t.clientY);
        } else if (isPanning) {
            const dx = (t.clientX - lastPanPos.x) / camera.zoom;
            const dy = (t.clientY - lastPanPos.y) / camera.zoom;
            camera.x -= dx;
            camera.y -= dy;
            lastPanPos = { x: t.clientX, y: t.clientY };
        }
    } else if (e.touches.length === 2) {
        const dist = Math.hypot(
            e.touches[0].clientX - e.touches[1].clientX,
            e.touches[0].clientY - e.touches[1].clientY
        );
        if (touchStartDist > 0) {
            const ratio = dist / touchStartDist;
            camera.zoom = Math.max(0.12, Math.min(2.5, touchStartZoom * ratio));
        }
    }
}, { passive: false });

canvas.addEventListener('touchend', (e) => {
    if (e.changedTouches.length > 0) {
        const t = e.changedTouches[0];
        const moveDist = Math.hypot(t.clientX - pointerDownPos.x, t.clientY - pointerDownPos.y);
        const world = screenToWorld(t.clientX, t.clientY);
        const target = findIslandNear(world.x, world.y);

        if (isDraggingAttack && dragSourceId) {
            if (target && target.id !== dragSourceId) {
                executeAttack(dragSourceId, target.id);
            }
            isDraggingAttack = false;
            dragSourceId = null;
            return;
        }

        isPanning = false;

        if (moveDist < 12) {
            if (target) {
                if (target.owner === myId) {
                    selectIsland(target);
                } else if (selectedIslandId) {
                    executeAttack(selectedIslandId, target.id);
                } else {
                    selectIsland(target);
                }
            } else {
                const sx = Math.floor(world.x / SECTOR_SIZE);
                const sy = Math.floor(world.y / SECTOR_SIZE);
                if (sx >= 0 && sx < MAP_SECTORS && sy >= 0 && sy < MAP_SECTORS) {
                    const key = `${sx}_${sy}`;
                    if (!discoveredSectors.has(key)) {
                        socket.emit('dispatchScout', { sx, sy });
                    } else {
                        selectIsland(null);
                    }
                }
            }
        }
    }
});

// ==========================================
// 6. SOCKET SYNCHRONIZATION
// ==========================================
socket.on('scoutUpdate', (scoutData) => {
    scout = scoutData;
    updateHUD();
});

socket.on('autoScoutState', (enabled) => {
    autoScoutEnabled = enabled;
    updateHUD();
});

socket.on('sectorCharted', (data) => {
    discoveredSectors.add(data.sector.key);
    data.sector.islands.forEach(isle => islandLookup.set(isle.id, isle));
    scout = data.scout;
    updateHUD();
    renderScores();
});

socket.on('islandUpdated', (data) => {
    if (islandLookup.has(data.id)) {
        const isle = islandLookup.get(data.id);
        isle.population = data.population;
        isle.gold = data.gold;
        isle.owner = data.owner;
        if (selectedIslandId === data.id) refreshArmory(isle);
        renderScores();
    }
});

socket.on('islandUpgraded', (data) => {
    if (islandLookup.has(data.id)) {
        const isle = islandLookup.get(data.id);
        isle.gold = data.gold;
        isle.speed = data.speed;
        isle.range = data.range;
        isle.defense = data.defense;
        isle.upgrades = data.upgrades;
        if (selectedIslandId === data.id) refreshArmory(isle);
    }
});

socket.on('islandsSync', (islandsList) => {
    islandsList.forEach(fresh => {
        if (islandLookup.has(fresh.id)) {
            const local = islandLookup.get(fresh.id);
            local.population = fresh.population;
            local.gold = fresh.gold;
            local.owner = fresh.owner;
        }
    });
    if (selectedIslandId && islandLookup.has(selectedIslandId)) {
        refreshArmory(islandLookup.get(selectedIslandId));
    }
    renderScores();
});

socket.on('voyageLaunched', (v) => activeVoyages.set(v.id, v));
socket.on('voyageArrived', (data) => activeVoyages.delete(data.id));

socket.on('gameOver', (winner) => {
    const modal = document.getElementById('game-over-modal');
    const title = document.getElementById('game-over-title');
    const desc = document.getElementById('game-over-desc');

    if (winner.id === myId) {
        title.innerText = "OCEANIC TRIUMPH!";
        title.style.color = "#00ff77";
        desc.innerText = `YOU CONQUERED ${winner.pct}% OF THE MAP`;
    } else {
        title.innerText = "FLEET SUBJUGATED";
        title.style.color = "#ff3b3b";
        desc.innerText = `${winner.name} TOOK ${winner.pct}% OF THE SEAS`;
    }
    modal.classList.remove('hidden');
});

// ==========================================
// 7. HUD & BUTTON WIRING
// ==========================================
document.getElementById('auto-scout-btn').onclick = () => {
    socket.emit('toggleAutoScout', !autoScoutEnabled);
};

document.querySelectorAll('.pct-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.pct-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sendTroopRatio = parseFloat(btn.dataset.pct);
    };
});

document.querySelectorAll('.gold-pct-btn').forEach(btn => {
    btn.onclick = () => {
        document.querySelectorAll('.gold-pct-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sendGoldRatio = parseFloat(btn.dataset.gold);
    };
});

function updateHUD() {
    const statusText = document.getElementById('scout-status');
    const autoBtn = document.getElementById('auto-scout-btn');

    if (autoScoutEnabled) {
        autoBtn.innerText = "AUTO-SCOUT: ACTIVE";
        autoBtn.classList.add('active');
    } else {
        autoBtn.innerText = "AUTO-SCOUT: OFF";
        autoBtn.classList.remove('active');
    }

    if (scout.state === 'CHARTING' && scout.targetSector) {
        statusText.innerText = `SCANNING [${scout.targetSector.sx}, ${scout.targetSector.sy}]...`;
        statusText.style.color = '#f5b041';
    } else {
        statusText.innerText = `RADAR: DOCKED [${scout.currentSector.sx}, ${scout.currentSector.sy}]`;
        statusText.style.color = '#00ff77';
        document.getElementById('progress-fill').style.width = '0%';
    }
}

function renderScores() {
    let p1Points = 0;
    let p2Points = 0;

    for (const [id, isle] of islandLookup) {
        if (isle.owner === myId) p1Points += isle.points;
        else if (isle.owner !== null) p2Points += isle.points;
    }

    const p1Pct = Math.min(100, (p1Points / totalWorldPoints) * 100);
    const p2Pct = Math.min(100, (p2Points / totalWorldPoints) * 100);

    document.getElementById('score-p1').innerText = `${myName}: ${p1Points} pts (${p1Pct.toFixed(1)}%)`;
    document.getElementById('score-p2').innerText = `${enemyName}: ${p2Points} pts (${p2Pct.toFixed(1)}%)`;

    document.getElementById('score-bar-p1').style.width = `${p1Pct}%`;
    document.getElementById('score-bar-p2').style.width = `${p2Pct}%`;
}

const standbyView = document.getElementById('standby-view');
const armoryView = document.getElementById('armory-view');
document.getElementById('close-inspector-btn').onclick = () => selectIsland(null);

function showStandby() {
    standbyView.style.display = 'flex';
    armoryView.style.display = 'none';
    selectedIslandId = null;
}

function showArmory(isle) {
    standbyView.style.display = 'none';
    armoryView.style.display = 'flex';
    refreshArmory(isle);
}

function refreshArmory(isle) {
    document.getElementById('inspector-name').innerText = isle.name;
    document.getElementById('stat-type').innerText = isle.type;
    document.getElementById('stat-pop').innerText = `${isle.population} / ${isle.maxPop}`;
    document.getElementById('stat-gold').innerText = `🪙 ${isle.gold} / ${isle.maxGold}`;
    document.getElementById('stat-points').innerText = `${isle.points} pts`;

    const up = isle.upgrades || { speed: 0, range: 0, defense: 0 };
    document.getElementById('up-speed-val').innerText = `${isle.speed} (Lv ${up.speed})`;
    document.getElementById('up-range-val').innerText = `${isle.range} (Lv ${up.range})`;
    document.getElementById('up-defense-val').innerText = `${isle.defense} (Lv ${up.defense})`;

    // 2x exponential curve on stat level AND 2x exponential curve on island tier level
    const speedCost = Math.floor(50 * Math.pow(2, up.speed) * Math.pow(2, isle.level - 1));
    const rangeCost = Math.floor(50 * Math.pow(2, up.range) * Math.pow(2, isle.level - 1));
    const defCost = Math.floor(50 * Math.pow(2, up.defense) * Math.pow(2, isle.level - 1));

    document.getElementById('up-speed-cost').innerText = speedCost;
    document.getElementById('up-range-cost').innerText = rangeCost;
    document.getElementById('up-defense-cost').innerText = defCost;

    const isMine = (isle.owner === myId);
    document.getElementById('buy-speed-btn').disabled = !isMine || isle.gold < speedCost || up.speed >= 5;
    document.getElementById('buy-range-btn').disabled = !isMine || isle.gold < rangeCost || up.range >= 5;
    document.getElementById('buy-defense-btn').disabled = !isMine || isle.gold < defCost || up.defense >= 5;

    document.getElementById('buy-speed-btn').onclick = () => socket.emit('upgradeIsland', { islandId: isle.id, type: 'speed' });
    document.getElementById('buy-range-btn').onclick = () => socket.emit('upgradeIsland', { islandId: isle.id, type: 'range' });
    document.getElementById('buy-defense-btn').onclick = () => socket.emit('upgradeIsland', { islandId: isle.id, type: 'defense' });
}

// ==========================================
// 8. MASTER RENDER LOOP
// ==========================================
function render(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;

    let moveX = 0;
    let moveY = 0;
    if (keysDown.has('KeyW') || keysDown.has('ArrowUp')) moveY -= 1;
    if (keysDown.has('KeyS') || keysDown.has('ArrowDown')) moveY += 1;
    if (keysDown.has('KeyA') || keysDown.has('ArrowLeft')) moveX -= 1;
    if (keysDown.has('KeyD') || keysDown.has('ArrowRight')) moveX += 1;

    if (moveX !== 0 && moveY !== 0) {
        moveX *= 0.7071;
        moveY *= 0.7071;
    }

    if (moveX !== 0 || moveY !== 0) {
        camera.x += (moveX * PAN_SPEED * dt) / camera.zoom;
        camera.y += (moveY * PAN_SPEED * dt) / camera.zoom;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    // 1. Sectors
    for (let sx = 0; sx < MAP_SECTORS; sx++) {
        for (let sy = 0; sy < MAP_SECTORS; sy++) {
            const key = `${sx}_${sy}`;
            const posX = sx * SECTOR_SIZE;
            const posY = sy * SECTOR_SIZE;

            if (discoveredSectors.has(key)) {
                ctx.fillStyle = '#051426';
                ctx.fillRect(posX, posY, SECTOR_SIZE, SECTOR_SIZE);

                ctx.strokeStyle = '#0d2d4f';
                ctx.lineWidth = 1;
                ctx.strokeRect(posX, posY, SECTOR_SIZE, SECTOR_SIZE);

                ctx.fillStyle = '#17365d';
                ctx.font = '11px "Share Tech Mono", monospace';
                ctx.fillText(`SECTOR [${sx}, ${sy}]`, posX + 14, posY + 24);
            } else {
                ctx.fillStyle = '#02060e';
                ctx.fillRect(posX, posY, SECTOR_SIZE, SECTOR_SIZE);

                ctx.strokeStyle = '#071626';
                ctx.lineWidth = 1;
                ctx.strokeRect(posX, posY, SECTOR_SIZE, SECTOR_SIZE);

                ctx.fillStyle = '#14253b';
                ctx.font = '16px "Share Tech Mono", monospace';
                ctx.textAlign = 'center';
                ctx.fillText('?', posX + SECTOR_SIZE / 2, posY + SECTOR_SIZE / 2);
                ctx.textAlign = 'left';
            }
        }
    }

    ctx.strokeStyle = 'rgba(0, 217, 255, 0.35)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, MAP_SECTORS * SECTOR_SIZE, MAP_SECTORS * SECTOR_SIZE);

    const activeSelected = selectedIslandId ? islandLookup.get(selectedIslandId) : null;
    const sourceIsland = dragSourceId ? islandLookup.get(dragSourceId) : activeSelected;

    if (sourceIsland && sourceIsland.owner === myId) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sourceIsland.x, sourceIsland.y, sourceIsland.range, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 255, 119, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 8]);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0, 255, 119, 0.03)';
        ctx.fill();
        ctx.restore();
    }

    for (const [id, isle] of islandLookup) {
        drawIsland(isle);
    }

    drawVoyagesAndAlerts();

    if (isDraggingAttack && sourceIsland) {
        drawAttackArrow(sourceIsland, dragCurrentPos.x, dragCurrentPos.y);
    }

    drawScoutVessel();

    ctx.restore();

    if (scout.state === 'CHARTING') {
        const elapsed = Date.now() - scout.startTime;
        const pct = Math.min(100, (elapsed / scout.duration) * 100);
        document.getElementById('progress-fill').style.width = `${pct}%`;
    }

    requestAnimationFrame(render);
}

function drawIsland(isle) {
    const isMine = (isle.owner === myId);
    const isEnemy = (isle.owner !== null && isle.owner !== myId);
    const isGoldMine = (isle.type === 'MINE');
    const isSelected = (selectedIslandId === isle.id);
    const radius = getIslandRadius(isle);

    ctx.beginPath();
    ctx.arc(isle.x, isle.y, radius, 0, Math.PI * 2);

    ctx.fillStyle = isMine 
        ? 'rgba(0, 255, 119, 0.15)' 
        : isEnemy 
            ? 'rgba(255, 59, 59, 0.15)' 
            : (isGoldMine ? 'rgba(245, 176, 65, 0.18)' : 'rgba(25, 40, 55, 0.85)');
    ctx.fill();

    const themeColor = isMine ? '#00ff77' : (isEnemy ? '#ff3b3b' : (isGoldMine ? '#f5b041' : '#7f93a5'));
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = isMine ? 2.5 : (radius >= 80 ? 3.0 : 1.5);
    ctx.stroke();

    if (isSelected) {
        ctx.save();
        const pulse = 4 + (Date.now() % 600) / 75;
        ctx.beginPath();
        ctx.arc(isle.x, isle.y, radius + pulse, 0, Math.PI * 2);
        ctx.strokeStyle = '#00ff77';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
    }

    if (radius >= 40) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(isle.x, isle.y, radius * 0.7, 0, Math.PI * 2);
        ctx.strokeStyle = themeColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.stroke();
        ctx.restore();
    }

    ctx.textAlign = 'center';

    if (radius <= 10) {
        ctx.fillStyle = themeColor;
        ctx.font = 'bold 9px "Share Tech Mono", monospace';
        const tag = isGoldMine ? `🪙M${isle.level}` : `T${isle.level}`;
        ctx.fillText(tag, isle.x, isle.y - radius - 5);
        ctx.fillText(`${isle.population}`, isle.x, isle.y + radius + 11);
    } else {
        if (isle.gold > 0) {
            ctx.fillStyle = '#f5b041';
            ctx.font = 'bold 10px "Share Tech Mono", monospace';
            ctx.fillText(`🪙${isle.gold}`, isle.x, isle.y - radius - 6);
        }

        ctx.fillStyle = themeColor;
        const badgeSize = Math.min(24, 10 + Math.floor(radius * 0.2));
        ctx.font = `bold ${badgeSize}px "Rajdhani", sans-serif`;
        const label = isGoldMine ? `⛏️M${isle.level}` : `T${isle.level}`;
        ctx.fillText(label, isle.x, isle.y + badgeSize * 0.35);

        ctx.font = 'bold 11px "Share Tech Mono", monospace';
        ctx.fillText(`👥${isle.population}/${isle.maxPop}`, isle.x, isle.y + radius + 14);
    }

    ctx.textAlign = 'left';
}

function drawAttackArrow(source, tx, ty) {
    const fx = source.x;
    const fy = source.y;
    const dist = Math.hypot(tx - fx, ty - fy);
    const range = source.range;

    const decay = Math.pow(2, -(dist / range));
    const sent = Math.floor(source.population * sendTroopRatio);
    const estimatedArrive = Math.max(1, Math.floor(sent * decay));
    const efficiency = Math.round(decay * 100);

    const isOutOfReach = dist > range * 1.5;
    const strokeColor = isOutOfReach ? '#ff3b3b' : '#00ff77';

    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([8, 6]);
    ctx.moveTo(fx, fy);
    ctx.lineTo(tx, ty);
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.setLineDash([]);

    const angle = Math.atan2(ty - fy, tx - fx);
    ctx.translate(tx, ty);
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(-12, -6);
    ctx.lineTo(-12, 6);
    ctx.closePath();
    ctx.fillStyle = strokeColor;
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 11px "Share Tech Mono", monospace';
    ctx.fillText(`Troops: ${sent} ➔ ${estimatedArrive} (${efficiency}%) | Gold: ${Math.floor(source.gold * sendGoldRatio)}`, tx + 14, ty - 8);
}

function drawVoyagesAndAlerts() {
    const now = Date.now();

    for (const [id, v] of activeVoyages) {
        const isMine = (v.owner === myId);
        const targetIsland = islandLookup.get(v.toId);
        const isAttackingMyIsland = (targetIsland && targetIsland.owner === myId && !isMine);

        const remainingMs = Math.max(0, v.arrivalTime - now);
        const remainingSec = (remainingMs / 1000).toFixed(1);
        const progress = Math.min(1.0, (now - v.startTime) / v.duration);

        const curX = v.startX + (v.targetX - v.startX) * progress;
        const curY = v.startY + (v.targetY - v.startY) * progress;

        const curSectorKey = `${Math.floor(curX / SECTOR_SIZE)}_${Math.floor(curY / SECTOR_SIZE)}`;
        const isCurrentPosInFog = !discoveredSectors.has(curSectorKey);

        if (!isMine && !isAttackingMyIsland && isCurrentPosInFog) {
            continue;
        }

        if (isAttackingMyIsland) {
            ctx.save();
            ctx.beginPath();
            ctx.setLineDash([8, 8]);
            ctx.moveTo(curX, curY);
            ctx.lineTo(targetIsland.x, targetIsland.y);
            ctx.strokeStyle = '#ff3b3b';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.setLineDash([]);

            const pulse = 10 + (Date.now() % 800) / 40;
            ctx.beginPath();
            ctx.arc(targetIsland.x, targetIsland.y, getIslandRadius(targetIsland) + pulse, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(255, 59, 59, 0.5)';
            ctx.lineWidth = 2;
            ctx.stroke();

            ctx.fillStyle = 'rgba(4, 15, 30, 0.85)';
            ctx.fillRect(targetIsland.x - 70, targetIsland.y - getIslandRadius(targetIsland) - 30, 140, 20);
            ctx.strokeStyle = '#ff3b3b';
            ctx.lineWidth = 1;
            ctx.strokeRect(targetIsland.x - 70, targetIsland.y - getIslandRadius(targetIsland) - 30, 140, 20);

            ctx.fillStyle = '#ff4d4d';
            ctx.font = 'bold 10px "Share Tech Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(`⏱️ ${remainingSec}s | ⚔️${v.effectivePop}`, targetIsland.x, targetIsland.y - getIslandRadius(targetIsland) - 16);
            ctx.textAlign = 'left';
            ctx.restore();
        }

        const isOriginInFog = !discoveredSectors.has(`${Math.floor(v.startX / SECTOR_SIZE)}_${Math.floor(v.startY / SECTOR_SIZE)}`);
        if (isMine || (!isOriginInFog && !isCurrentPosInFog)) {
            ctx.beginPath();
            ctx.setLineDash([4, 4]);
            ctx.moveTo(v.startX, v.startY);
            ctx.lineTo(curX, curY);
            ctx.strokeStyle = isMine ? 'rgba(0, 255, 119, 0.4)' : 'rgba(255, 59, 59, 0.4)';
            ctx.lineWidth = 1.5;
            ctx.stroke();
            ctx.setLineDash([]);
        }

        ctx.beginPath();
        ctx.arc(curX, curY, 5, 0, Math.PI * 2);
        ctx.fillStyle = isMine ? '#00ff77' : '#ff3b3b';
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px "Share Tech Mono", monospace';
        ctx.fillText(`${v.effectivePop}`, curX + 8, curY + 3);
    }
}

function drawScoutVessel() {
    if (scout.state === 'CHARTING' && scout.targetSector) {
        const fromX = (scout.currentSector.sx + 0.5) * SECTOR_SIZE;
        const fromY = (scout.currentSector.sy + 0.5) * SECTOR_SIZE;
        const toX = (scout.targetSector.sx + 0.5) * SECTOR_SIZE;
        const toY = (scout.targetSector.sy + 0.5) * SECTOR_SIZE;

        const elapsed = Date.now() - scout.startTime;
        const progress = Math.min(1.0, elapsed / scout.duration);

        const currentX = fromX + (toX - fromX) * progress;
        const currentY = fromY + (toY - fromY) * progress;

        ctx.beginPath();
        ctx.setLineDash([6, 6]);
        ctx.moveTo(fromX, fromY);
        ctx.lineTo(toX, toY);
        ctx.strokeStyle = '#f5b041';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(currentX, currentY, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#f5b041';
        ctx.fill();

        const pingRadius = 15 + (Date.now() % 1000) / 25;
        ctx.beginPath();
        ctx.arc(currentX, currentY, pingRadius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(245, 176, 65, 0.45)';
        ctx.stroke();
    }
}

requestAnimationFrame(render);