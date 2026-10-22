// public/client.js
const socket = io();
const canvas = document.getElementById('viewport');
const ctx = canvas.getContext('2d');

let myId = null;
let myName = "ANON";
let enemyId = null;
let enemyName = "ENEMY";
let totalWorldPoints = 1;
let SECTOR_SIZE = 800;
let MAP_SECTORS = 10;
let SCOUT_TIME_MS = 30000;

// Camera
let camera = { x: 400, y: 400, zoom: 0.75 };
const PAN_SPEED = 700;
const keysDown = new Set();
let lastTime = performance.now();

// Game State
const discoveredSectors = new Set();
const islandLookup = new Map();
const activeVoyages = new Map();
let scout = { state: 'IDLE', currentSector: { sx: 0, sy: 0 }, targetSector: null };
let autoScoutEnabled = false;

// Attack & Transport selections
let sendTroopRatio = 0.50;
let sendGoldRatio = 0.0;
let isDraggingAttack = false;
let dragSourceId = null;
let dragCurrentPos = { x: 0, y: 0 };
let clickOrigin = { x: 0, y: 0 };
let selectedIslandId = null;

// ==========================================
// 1. DYNAMIC POWER-OF-2 ISLAND SIZING
// ==========================================
function getIslandRadius(isle) {
    // Exact requested progression:
    // Level 1: 5px
    // Level 2: 10px
    // Level 3: 20px
    // Level 4: 40px
    // Level 5: 80px
    // Level 6: 160px
    // Level 7: 320px
    const radii = [0, 5, 10, 20, 40, 80, 160, 320];
    return radii[isle.level] || 5;
}

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
}
window.addEventListener('resize', resize);
resize();

// ==========================================
// 2. LOBBY & PRE-GAME UI HANDLERS
// ==========================================
const nameModal = document.getElementById('name-modal');
const lobbyModal = document.getElementById('lobby-modal');
const gameHud = document.getElementById('game-hud');
const nameInput = document.getElementById('player-name-input');
const submitNameBtn = document.getElementById('submit-name-btn');
const createLobbyBtn = document.getElementById('create-lobby-btn');
const refreshLobbiesBtn = document.getElementById('refresh-lobbies-btn');
const lobbyList = document.getElementById('lobby-list');
const displayCallsign = document.getElementById('display-callsign');
const waitingNotice = document.getElementById('waiting-notice');

submitNameBtn.onclick = () => {
    const val = nameInput.value.trim().slice(0, 4);
    if (!val) return;
    socket.emit('setPlayerName', val);
};

nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNameBtn.click();
});

socket.on('nameConfirmed', (name) => {
    myName = name;
    nameModal.classList.add('hidden');
    lobbyModal.classList.remove('hidden');
    displayCallsign.innerText = myName;
    socket.emit('getLobbies');
});

createLobbyBtn.onclick = () => {
    socket.emit('createLobby');
};

refreshLobbiesBtn.onclick = () => {
    socket.emit('getLobbies');
};

socket.on('lobbyCreated', (data) => {
    createLobbyBtn.disabled = true;
    waitingNotice.classList.remove('hidden');
});

socket.on('lobbyUpdated', () => {
    socket.emit('getLobbies');
});

socket.on('lobbyList', (list) => {
    lobbyList.innerHTML = '';
    if (list.length === 0) {
        lobbyList.innerHTML = '<div class="empty-notice">No open lobbies found. Create one!</div>';
        return;
    }

    list.forEach(item => {
        const row = document.createElement('div');
        row.className = 'lobby-item';
        row.innerHTML = `
            <div>
                <strong>${item.host}'S LOBBY</strong> [${item.id}]
            </div>
            <button class="join-btn" data-id="${item.id}">ENGAGE</button>
        `;
        row.querySelector('.join-btn').onclick = () => {
            socket.emit('joinLobby', item.id);
        };
        lobbyList.appendChild(row);
    });
});

socket.on('gameStarted', (data) => {
    nameModal.classList.add('hidden');
    lobbyModal.classList.add('hidden');
    gameHud.classList.remove('hidden');

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

    discoveredSectors.clear();
    islandLookup.clear();

    data.revealedSectors.forEach(sec => {
        discoveredSectors.add(sec.key);
        sec.islands.forEach(isle => islandLookup.set(isle.id, isle));
    });

    // Center camera on starter sector
    const myHome = Array.from(islandLookup.values()).find(i => i.owner === myId);
    if (myHome) {
        camera.x = myHome.x;
        camera.y = myHome.y;
    }

    updateHUD();
});

// ==========================================
// 3. MOUSE & KEYBOARD PANNING
// ==========================================
const PAN_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];

window.addEventListener('keydown', (e) => {
    if (PAN_KEYS.includes(e.code)) {
        e.preventDefault();
        keysDown.add(e.code);
    }
});

window.addEventListener('keyup', (e) => {
    if (PAN_KEYS.includes(e.code)) {
        e.preventDefault();
        keysDown.delete(e.code);
    }
});

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
        // Generous hitbox tolerance for tiny 5px and 10px islands
        const hitRadius = Math.max(18, radius + 8);
        const dist = Math.hypot(isle.x - wx, isle.y - wy);

        if (dist <= hitRadius && dist < minDist) {
            minDist = dist;
            closest = isle;
        }
    }
    return closest;
}

window.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;

    const world = screenToWorld(e.clientX, e.clientY);
    clickOrigin = { x: e.clientX, y: e.clientY };
    const clicked = findIslandNear(world.x, world.y);

    if (clicked && clicked.owner === myId) {
        isDraggingAttack = true;
        dragSourceId = clicked.id;
        dragCurrentPos = world;
        openInspector(clicked);
    } else if (clicked) {
        openInspector(clicked);
    }
});

window.addEventListener('mousemove', (e) => {
    if (isDraggingAttack) {
        dragCurrentPos = screenToWorld(e.clientX, e.clientY);
    }
});

window.addEventListener('mouseup', (e) => {
    const world = screenToWorld(e.clientX, e.clientY);

    if (isDraggingAttack && dragSourceId) {
        const target = findIslandNear(world.x, world.y);
        if (target && target.id !== dragSourceId) {
            socket.emit('sendVoyage', {
                fromId: dragSourceId,
                toId: target.id,
                percentage: sendTroopRatio,
                goldRatio: sendGoldRatio
            });
        }
        isDraggingAttack = false;
        dragSourceId = null;
        return;
    }

    const moved = Math.hypot(e.clientX - clickOrigin.x, e.clientY - clickOrigin.y);
    if (moved < 5) {
        const sx = Math.floor(world.x / SECTOR_SIZE);
        const sy = Math.floor(world.y / SECTOR_SIZE);

        if (sx >= 0 && sx < MAP_SECTORS && sy >= 0 && sy < MAP_SECTORS) {
            const key = `${sx}_${sy}`;
            if (!discoveredSectors.has(key)) {
                socket.emit('dispatchScout', { sx, sy });
            }
        }
    }
});

window.addEventListener('wheel', (e) => {
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    camera.zoom = Math.max(0.15, Math.min(2.5, camera.zoom * factor));
});

// ==========================================
// 4. SOCKET SYNCHRONIZATION
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
        if (selectedIslandId === data.id) refreshInspector(isle);
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
        if (selectedIslandId === data.id) refreshInspector(isle);
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
        refreshInspector(islandLookup.get(selectedIslandId));
    }
    renderScores();
});

socket.on('voyageLaunched', (v) => {
    activeVoyages.set(v.id, v);
});

socket.on('voyageArrived', (data) => {
    activeVoyages.delete(data.id);
});

socket.on('gameOver', (winner) => {
    const modal = document.getElementById('game-over-modal');
    const title = document.getElementById('game-over-title');
    const desc = document.getElementById('game-over-desc');

    if (winner.id === myId) {
        title.innerText = "OCEANIC TRIUMPH!";
        title.style.color = "#00ff66";
        desc.innerText = `YOU CONQUERED ${winner.pct}% OF THE MAP`;
    } else {
        title.innerText = "FLEET SUBJUGATED";
        title.style.color = "#e74c3c";
        desc.innerText = `${winner.name} TOOK ${winner.pct}% OF THE SEAS`;
    }
    modal.classList.remove('hidden');
});

// ==========================================
// 5. HUD & SCOREBOARD
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
        autoBtn.innerText = "AUTO-SCOUT: ON";
        autoBtn.classList.add('active');
    } else {
        autoBtn.innerText = "AUTO-SCOUT: OFF";
        autoBtn.classList.remove('active');
    }

    if (scout.state === 'CHARTING' && scout.targetSector) {
        statusText.innerText = `Radar: Scanning [${scout.targetSector.sx}, ${scout.targetSector.sy}]...`;
        statusText.style.color = '#f39c12';
    } else {
        statusText.innerText = `Radar: Docked [${scout.currentSector.sx}, ${scout.currentSector.sy}]`;
        statusText.style.color = '#00ff66';
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

// ==========================================
// 6. DOCKYARD INSPECTOR & GOLD UPGRADES
// ==========================================
const inspector = document.getElementById('island-inspector');
document.getElementById('close-inspector-btn').onclick = () => {
    inspector.classList.add('hidden');
    selectedIslandId = null;
};

function openInspector(isle) {
    selectedIslandId = isle.id;
    inspector.classList.remove('hidden');
    refreshInspector(isle);
}

function refreshInspector(isle) {
    document.getElementById('inspector-name').innerText = isle.name;
    document.getElementById('stat-type').innerText = isle.type;
    document.getElementById('stat-pop').innerText = `${isle.population} / ${isle.maxPop}`;
    document.getElementById('stat-gold').innerText = `🪙 ${isle.gold} / ${isle.maxGold}`;
    document.getElementById('stat-points').innerText = `${isle.points} pts`;

    const up = isle.upgrades || { speed: 0, range: 0, defense: 0 };
    document.getElementById('up-speed-val').innerText = `${isle.speed} (Lv ${up.speed})`;
    document.getElementById('up-range-val').innerText = `${isle.range} (Lv ${up.range})`;
    document.getElementById('up-defense-val').innerText = `${isle.defense} (Lv ${up.defense})`;

    const speedCost = Math.floor(50 * Math.pow(1.6, up.speed));
    const rangeCost = Math.floor(50 * Math.pow(1.6, up.range));
    const defCost = Math.floor(50 * Math.pow(1.6, up.defense));

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
// 7. MASTER RENDER LOOP
// ==========================================
function render(now) {
    const dt = Math.min(0.1, (now - lastTime) / 1000);
    lastTime = now;

    // Panning
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

    // 1. Draw 10x10 Sectors
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
                ctx.font = '11px Courier New';
                ctx.fillText(`SECTOR [${sx}, ${sy}]`, posX + 14, posY + 24);
            } else {
                ctx.fillStyle = '#02060e';
                ctx.fillRect(posX, posY, SECTOR_SIZE, SECTOR_SIZE);

                ctx.strokeStyle = '#071626';
                ctx.lineWidth = 1;
                ctx.strokeRect(posX, posY, SECTOR_SIZE, SECTOR_SIZE);

                ctx.fillStyle = '#14253b';
                ctx.font = '16px Courier New';
                ctx.textAlign = 'center';
                ctx.fillText('?', posX + SECTOR_SIZE / 2, posY + SECTOR_SIZE / 2);
                ctx.textAlign = 'left';
            }
        }
    }

    // Map Border
    ctx.strokeStyle = 'rgba(0, 255, 102, 0.3)';
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, MAP_SECTORS * SECTOR_SIZE, MAP_SECTORS * SECTOR_SIZE);

    const sourceIsland = dragSourceId ? islandLookup.get(dragSourceId) : null;

    // 2. Nautical Range Ring
    if (isDraggingAttack && sourceIsland) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(sourceIsland.x, sourceIsland.y, sourceIsland.range, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(0, 255, 102, 0.3)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([8, 8]);
        ctx.stroke();
        ctx.fillStyle = 'rgba(0, 255, 102, 0.03)';
        ctx.fill();
        ctx.restore();
    }

    // 3. Draw Islands
    for (const [id, isle] of islandLookup) {
        drawIsland(isle);
    }

    // 4. Draw Active Voyages & Dark Forest Stopwatch Warnings
    drawVoyagesAndAlerts();

    // 5. Draw Attack Arrow
    if (isDraggingAttack && sourceIsland) {
        drawAttackArrow(sourceIsland, dragCurrentPos.x, dragCurrentPos.y);
    }

    // 6. Draw Scout Vessel
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
    const radius = getIslandRadius(isle);

    ctx.beginPath();
    ctx.arc(isle.x, isle.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = isMine 
        ? 'rgba(0, 255, 102, 0.15)' 
        : isEnemy ? 'rgba(231, 76, 60, 0.15)' : 'rgba(25, 40, 55, 0.85)';
    ctx.fill();

    const themeColor = isMine ? '#00ff66' : isEnemy ? '#e74c3c' : '#7f93a5';
    ctx.strokeStyle = themeColor;
    ctx.lineWidth = isMine ? 2.5 : (radius >= 80 ? 3.0 : 1.5);
    ctx.stroke();

    // High Tier Concentric Bastion Rings
    if (radius >= 40) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(isle.x, isle.y, radius * 0.7, 0, Math.PI * 2);
        ctx.strokeStyle = themeColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 6]);
        ctx.stroke();

        if (radius >= 160) {
            ctx.beginPath();
            ctx.arc(isle.x, isle.y, radius * 0.45, 0, Math.PI * 2);
            ctx.strokeStyle = themeColor;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 5]);
            ctx.stroke();
        }
        ctx.restore();
    }

    ctx.textAlign = 'center';

    // Smart label rendering: avoid cluttering 5px/10px circles
    if (radius <= 10) {
        // Compact display
        ctx.fillStyle = themeColor;
        ctx.font = 'bold 9px Courier New';
        ctx.fillText(`T${isle.level}`, isle.x, isle.y - radius - 4);
        ctx.fillText(`${isle.population}`, isle.x, isle.y + radius + 10);
    } else {
        // Detailed display
        if (isle.gold > 0) {
            ctx.fillStyle = '#f1c40f';
            ctx.font = 'bold 10px Courier New';
            ctx.fillText(`🪙${isle.gold}`, isle.x, isle.y - radius - 6);
        }

        ctx.fillStyle = themeColor;
        const badgeSize = Math.min(24, 10 + Math.floor(radius * 0.2));
        ctx.font = `bold ${badgeSize}px Courier New`;
        const label = isle.type === 'MINE' ? `⛏️M${isle.level}` : `T${isle.level}`;
        ctx.fillText(label, isle.x, isle.y + badgeSize * 0.35);

        ctx.font = 'bold 11px Courier New';
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
    const strokeColor = isOutOfReach ? '#e74c3c' : '#00ff66';

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
    ctx.font = 'bold 11px Courier New';
    ctx.fillText(`Troops: ${sent} ➔ ${estimatedArrive} (${efficiency}%) | Gold: ${Math.floor(source.gold * sendGoldRatio)}`, tx + 14, ty - 8);
}

// ==========================================
// 8. DARK FOREST RADAR & INCOMING STOPWATCH
// ==========================================
function drawVoyagesAndAlerts() {
    const now = Date.now();

    for (const [id, v] of activeVoyages) {
        const remainingMs = Math.max(0, v.arrivalTime - now);
        const remainingSec = (remainingMs / 1000).toFixed(1);
        const progress = Math.min(1.0, (now - v.startTime) / v.duration);

        const curX = v.startX + (v.targetX - v.startX) * progress;
        const curY = v.startY + (v.targetY - v.startY) * progress;
        const isMine = (v.owner === myId);

        // Friendly or visible voyage line
        ctx.beginPath();
        ctx.setLineDash([4, 4]);
        ctx.moveTo(v.startX, v.startY);
        ctx.lineTo(curX, curY);
        ctx.strokeStyle = isMine ? 'rgba(0, 255, 102, 0.4)' : 'rgba(231, 76, 60, 0.4)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);

        // Voyage Fleet Marker
        ctx.beginPath();
        ctx.arc(curX, curY, 5, 0, Math.PI * 2);
        ctx.fillStyle = isMine ? '#00ff66' : '#e74c3c';
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 10px Courier New';
        ctx.fillText(`${v.effectivePop}`, curX + 8, curY + 3);

        // DARK FOREST RADAR ALERT:
        // If an enemy attacks one of MY islands, even through the fog of war,
        // draw a red dashed attack vector and an active ticking stopwatch!
        const targetIsland = islandLookup.get(v.toId);
        if (targetIsland && targetIsland.owner === myId && !isMine) {
            ctx.save();
            // Red dashed attack vector directly into our defended island
            ctx.beginPath();
            ctx.setLineDash([8, 8]);
            ctx.moveTo(curX, curY);
            ctx.lineTo(targetIsland.x, targetIsland.y);
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 2.5;
            ctx.stroke();
            ctx.setLineDash([]);

            // Defending Island Warning Pulse
            const pulse = 10 + (Date.now() % 800) / 40;
            ctx.beginPath();
            ctx.arc(targetIsland.x, targetIsland.y, getIslandRadius(targetIsland) + pulse, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(231, 76, 60, 0.5)';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Stopwatch Ticker Tag
            ctx.fillStyle = 'rgba(4, 15, 30, 0.85)';
            ctx.fillRect(targetIsland.x - 70, targetIsland.y - getIslandRadius(targetIsland) - 30, 140, 20);
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 1;
            ctx.strokeRect(targetIsland.x - 70, targetIsland.y - getIslandRadius(targetIsland) - 30, 140, 20);

            ctx.fillStyle = '#ff4d4d';
            ctx.font = 'bold 10px Courier New';
            ctx.textAlign = 'center';
            ctx.fillText(`⏱️ ${remainingSec}s | ⚔️${v.effectivePop}`, targetIsland.x, targetIsland.y - getIslandRadius(targetIsland) - 16);
            ctx.textAlign = 'left';
            ctx.restore();
        }
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
        ctx.strokeStyle = '#f39c12';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.beginPath();
        ctx.arc(currentX, currentY, 7, 0, Math.PI * 2);
        ctx.fillStyle = '#f1c40f';
        ctx.fill();

        const pingRadius = 15 + (Date.now() % 1000) / 25;
        ctx.beginPath();
        ctx.arc(currentX, currentY, pingRadius, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(241, 196, 15, 0.45)';
        ctx.stroke();
    }
}

requestAnimationFrame(render);