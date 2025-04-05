import { createNoise2D } from 'simplex-noise';

const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const scoreElement = document.getElementById('score');
const leaderboardList = document.getElementById('leaderboard-list');
const portalsContainer = document.getElementById('portals');
const healthBarFill = document.getElementById('health-bar-fill');
const healthText = document.getElementById('health-text');

const room = new WebsimSocket();

const CHUNK_SIZE = 512; // Size of each chunk in pixels
const PLAYER_RADIUS = 10;
const BULLET_RADIUS = 5;
const MAX_SPEED = 3;
const START_TIME = Date.now();
const MAX_HEALTH = 100;
const HEALTH_REGEN_RATE = 2; // Health points per second
const BULLET_DAMAGE = 15; // Base damage per bullet hit
const DODGER_BULLET_DAMAGE = 10; // Damage for dodger bullets
const EXPLOSION_DURATION = 0.3; // seconds
const EXPLOSION_RADIUS = 30; // Max radius of explosion effect

let localPlayer = {
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  score: 0,
  health: MAX_HEALTH,
  maxHealth: MAX_HEALTH,
  lastUpdateTime: Date.now(),
  dead: false,
};

let players = {}; // Store other players' data { clientId: { x, y, username, avatarUrl, score, health, maxHealth, dead } }
let localChunks = {}; // Store chunk data generated locally { 'x_y': { npcs: [...], obstacles: [...] } }
let remoteChunks = {}; // Store chunk data received from peers { 'x_y': { clientId: chunkData } }
let activeChunkPortals = {}; // Store conflicting chunks needing resolution { 'x_y': [clientId1, clientId2, ...] }
let bullets = []; // { x, y, vx, vy, ownerChunkX, ownerChunkY, type: 'shooter' | 'dodger' }
let explosions = []; // { x, y, startTime, maxRadius }
let camera = { x: 0, y: 0 };
let keys = {};

const noise2D = createNoise2D();

// --- Game Initialization ---

async function initializeGame() {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  await room.initialize();

  // Initialize player presence
  localPlayer.x = room.roomState.spawnX || 0;
  localPlayer.y = room.roomState.spawnY || 0;
  room.updatePresence({
    x: localPlayer.x,
    y: localPlayer.y,
    score: localPlayer.score,
    health: localPlayer.health,
    maxHealth: localPlayer.maxHealth,
    dead: localPlayer.dead,
  });

  // Load chunks from localStorage
  loadChunksFromLocalStorage();

  // Subscribe to updates
  room.subscribePresence(handlePresenceUpdate);
  room.subscribeRoomState(handleRoomStateUpdate); // Primarily for potential future global state like spawn point
  room.subscribePresenceUpdateRequests(handlePresenceUpdateRequest);
  room.onmessage = handleRoomMessages;

  // Start game loop
  gameLoop();
}

function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}

// --- Input Handling ---

function handleKeyDown(event) {
  keys[event.key.toLowerCase()] = true;
}

function handleKeyUp(event) {
  keys[event.key.toLowerCase()] = false;
}

// --- Networking ---

function handlePresenceUpdate(presence) {
  players = {}; // Reset and repopulate
  for (const clientId in presence) {
    if (clientId !== room.clientId) {
       // Ensure default values if properties are missing from presence update
       const pData = presence[clientId];
      players[clientId] = {
        ...room.peers[clientId], // Add username/avatar first
        x: pData.x ?? 0,
        y: pData.y ?? 0,
        score: pData.score ?? 0,
        health: pData.health ?? MAX_HEALTH,
        maxHealth: pData.maxHealth ?? MAX_HEALTH,
        dead: pData.dead ?? false,
       };
    }
  }
  updateLeaderboard();
  syncChunksWithPeers(); // Trigger chunk sync when peers change
}

function handleRoomStateUpdate(roomState) {
    // Currently unused, but could handle global state changes
    // e.g., if spawn point moved dynamically
    if (roomState.spawnX !== undefined && roomState.spawnY !== undefined && !room.presence[room.clientId]) {
         // Only set initial spawn if player hasn't joined yet
        localPlayer.x = roomState.spawnX;
        localPlayer.y = roomState.spawnY;
    }
}

function handlePresenceUpdateRequest(updateRequest, fromClientId) {
    // Handle requests from other players, e.g., resolving chunk conflicts
    if (updateRequest.type === 'requestChunkData') {
        const chunkId = updateRequest.chunkId;
        if (localChunks[chunkId]) {
             room.send({ type: 'chunkDataResponse', chunkId, chunkData: localChunks[chunkId], targetClientId: fromClientId });
        }
    } else if (updateRequest.type === 'proposeChunkResolution') {
        const chunkId = updateRequest.chunkId;
        const proposedWinnerId = updateRequest.winnerClientId;
        // Simple resolution: accept the proposal if we have a conflict for this chunk
        if (activeChunkPortals[chunkId]) {
            resolveChunkConflict(chunkId, proposedWinnerId);
        }
    }
    // Future: Handle damage requests here if PvP is added
    // else if (updateRequest.type === 'inflictDamage') {
    //     takeDamage(updateRequest.amount);
    // }
}


function handleRoomMessages(event) {
    const data = event.data;
    switch (data.type) {
        case 'connected':
            console.log(`Client ${data.clientId}, ${data.username} connected`);
            syncChunksWithPeer(data.clientId); // Sync with the new peer
            break;
        case 'disconnected':
            console.log(`Client ${data.clientId}, ${data.username} disconnected`);
            // Remove chunks associated only with the disconnected peer if they were part of a conflict
            cleanUpDisconnectedPeerChunks(data.clientId);
            break;
        case 'chunkDataResponse':
             // Only process if the message is targeted at us
            if (data.targetClientId === room.clientId) {
                handleChunkDataResponse(data.chunkId, data.chunkData, data.clientId);
            }
            break;
        case 'bulletFired':
            if (data.clientId !== room.clientId) { // Don't add our own bullets twice
                bullets.push({ ...data.bulletData, remote: true });
            }
            break;
        case 'explosion': // Handle explosion event from others
             if (data.clientId !== room.clientId) {
                createExplosion(data.x, data.y);
            }
            break;
        // Handle other custom events
        default:
           // console.log("Received unknown event:", data);
           break; // Avoid logging every presence update message etc.
    }
}


// --- Chunk Management ---

function getChunkId(x, y) {
  const chunkX = Math.floor(x / CHUNK_SIZE);
  const chunkY = Math.floor(y / CHUNK_SIZE);
  return `${chunkX}_${chunkY}`;
}

function getChunkCoordinates(chunkId) {
  const parts = chunkId.split('_');
  return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) };
}

function getVisibleChunkIds() {
  const visibleChunks = new Set();
  const halfWidth = canvas.width / 2 / (camera.zoom || 1); // Adjust for potential zoom
  const halfHeight = canvas.height / 2 / (camera.zoom || 1);

  const minX = camera.x - halfWidth - CHUNK_SIZE; // Add buffer
  const maxX = camera.x + halfWidth + CHUNK_SIZE;
  const minY = camera.y - halfHeight - CHUNK_SIZE;
  const maxY = camera.y + halfHeight + CHUNK_SIZE;

  const startChunkX = Math.floor(minX / CHUNK_SIZE);
  const endChunkX = Math.floor(maxX / CHUNK_SIZE);
  const startChunkY = Math.floor(minY / CHUNK_SIZE);
  const endChunkY = Math.floor(maxY / CHUNK_SIZE);

  for (let cx = startChunkX; cx <= endChunkX; cx++) {
    for (let cy = startChunkY; cy <= endChunkY; cy++) {
      visibleChunks.add(`${cx}_${cy}`);
    }
  }
  return visibleChunks;
}

function generateChunkData(chunkX, chunkY) {
    const chunkId = `${chunkX}_${chunkY}`;
    const npcs = [];
    const obstacles = [];
    const distanceFactor = Math.sqrt(chunkX * chunkX + chunkY * chunkY);
    const seed = chunkX * 10000 + chunkY; // Simple seed based on coords
    const chunkNoise = createNoise2D(() => seed); // Seeded noise for this chunk

    // --- NPC Generation based on Distance ---
    let numNpcs = 0;
    let npcBaseSpeed = 0.3;
    let baseShootInterval = 15000;
    let shooterProbability = 0;
    let canShoot = false;

    // Spawn Chunk (0,0) - Explicitly 0 NPCs and add walls/gates
    if (chunkX === 0 && chunkY === 0) {
        numNpcs = 0; // Absolutely no NPCs in spawn
        console.log(`Chunk ${chunkId}: Generating Spawn Walls.`);

        // Define wall properties
        const wallThickness = 20;
        const halfChunk = CHUNK_SIZE / 2;
        const gateWidth = 80; // Width of the openings
        const halfGate = gateWidth / 2;

        // Create walls as obstacles (rectangles for simplicity, using radius conceptually)
        // We'll represent thick walls with several large-radius obstacles or just conceptual lines for now
        // Using simple rectangular obstacles:
        const wallColor = '#666'; // Give walls a distinct color if needed later

        // Wall segment calculations to leave gates centered
        const segmentLengthX = (CHUNK_SIZE - gateWidth) / 2;
        const segmentLengthY = (CHUNK_SIZE - gateWidth) / 2;

        // North Wall (two segments)
        obstacles.push({ id: `obs_spawn_n1`, x: -halfChunk + segmentLengthX / 2, y: -halfChunk + wallThickness / 2, width: segmentLengthX, height: wallThickness, type: 'wall' });
        obstacles.push({ id: `obs_spawn_n2`, x: halfChunk - segmentLengthX / 2, y: -halfChunk + wallThickness / 2, width: segmentLengthX, height: wallThickness, type: 'wall' });
        // South Wall (two segments)
        obstacles.push({ id: `obs_spawn_s1`, x: -halfChunk + segmentLengthX / 2, y: halfChunk - wallThickness / 2, width: segmentLengthX, height: wallThickness, type: 'wall' });
        obstacles.push({ id: `obs_spawn_s2`, x: halfChunk - segmentLengthX / 2, y: halfChunk - wallThickness / 2, width: segmentLengthX, height: wallThickness, type: 'wall' });
        // West Wall (two segments)
        obstacles.push({ id: `obs_spawn_w1`, x: -halfChunk + wallThickness / 2, y: -halfChunk + segmentLengthY / 2, width: wallThickness, height: segmentLengthY, type: 'wall' });
        obstacles.push({ id: `obs_spawn_w2`, x: -halfChunk + wallThickness / 2, y: halfChunk - segmentLengthY / 2, width: wallThickness, height: segmentLengthY, type: 'wall' });
        // East Wall (two segments)
        obstacles.push({ id: `obs_spawn_e1`, x: halfChunk - wallThickness / 2, y: -halfChunk + segmentLengthY / 2, width: wallThickness, height: segmentLengthY, type: 'wall' });
        obstacles.push({ id: `obs_spawn_e2`, x: halfChunk - wallThickness / 2, y: halfChunk - segmentLengthY / 2, width: wallThickness, height: segmentLengthY, type: 'wall' });


    }
    // Immediate adjacent chunks (distanceFactor approx 1 to 1.41)
    else if (distanceFactor < 2) {
         // Have a *chance* to spawn 1 NPC, not guaranteed
        if (chunkNoise(0,0) > 0.5) { // ~50% chance for 1 NPC
             numNpcs = 1;
        } else {
             numNpcs = 0;
        }
        npcBaseSpeed = 0.4; // Still very slow
        baseShootInterval = 18000 + Math.random() * 4000; // Even rarer shots (18-22s)
        shooterProbability = 0; // Still no shooters
        canShoot = false; // Cannot shoot this close
        console.log(`Chunk ${chunkId}: Adjacent to spawn, ${numNpcs} NPCs (slow, dodger only).`);
    }
    // Close chunks (distanceFactor 2 to < 5)
    else if (distanceFactor < 5) {
        // Max 1-2 NPCs, scaling slowly with noise
        numNpcs = Math.floor((chunkNoise(0,0) + 1) / 2 * 1.5); // 0, 1, or rarely 2 NPCs
        npcBaseSpeed = 0.5 + distanceFactor * 0.05; // Slightly faster: 0.6 to 0.75
        baseShootInterval = 5000 + Math.random() * 3000; // 5-8s interval
        shooterProbability = 0.05; // Very small chance of shooters
        canShoot = shooterProbability > 0; // Can only shoot if there's a chance of being a shooter
        console.log(`Chunk ${chunkId}: Close to spawn, ${numNpcs} NPCs.`);
    }
    // Further out chunks (distanceFactor >= 5)
    else {
        // Start with 1-2 base NPCs, scale slower
        numNpcs = 1 + Math.floor((chunkNoise(0,0) + 1) / 2 * (distanceFactor / 2)); // Scale more gradually, max depends on distance
        numNpcs = Math.min(numNpcs, 15); // Lower max NPC count overall
        npcBaseSpeed = 0.6 + distanceFactor * 0.08; // Slower speed scaling: starts at ~1.0, increases slower
        npcBaseSpeed = Math.min(npcBaseSpeed, MAX_SPEED * 0.8); // Cap NPC speed below player max speed
        baseShootInterval = 2500 + Math.random() * 1500; // 2.5-4s interval (more frequent further out)
        shooterProbability = 0.2 + Math.min(0.4, distanceFactor * 0.015); // Increase shooter probability slower, capped lower
        canShoot = true;
        console.log(`Chunk ${chunkId}: Farther out, ${numNpcs} NPCs (scaling).`);
    }

    // Generate the NPCs *only if* not in spawn chunk
    if (chunkX !== 0 || chunkY !== 0) {
        for (let i = 0; i < numNpcs; i++) {
            // Decide NPC type based on probability
            const npcType = (shooterProbability > 0 && Math.random() < shooterProbability) ? 'shooter' : 'dodger';
            // Adjust speed slightly based on noise, keep it within reasonable bounds
            const speedMultiplier = Math.max(0.2, npcBaseSpeed + (chunkNoise(i*5, i*5) * 0.1)); // Ensure minimum speed

            npcs.push({
                id: `npc_${chunkId}_${i}`,
                x: chunkX * CHUNK_SIZE + Math.random() * CHUNK_SIZE,
                y: chunkY * CHUNK_SIZE + Math.random() * CHUNK_SIZE,
                vx: (chunkNoise(i * 0.1, 0) * 2 - 1) * speedMultiplier,
                vy: (chunkNoise(0, i * 0.1) * 2 - 1) * speedMultiplier,
                type: npcType,
                lastShotTime: 0,
                 // Use the calculated base interval, adjust slightly per type
                shootInterval: baseShootInterval * (1 + (Math.random() * 0.4 - 0.2)) * (npcType === 'shooter' ? 0.9 : 1.1), // Add +-20% randomness + type adjustment
                radius: 8,
                canShoot: canShoot // Assign the determined shoot ability
            });
        }
    }


    // --- Obstacle Generation ---
     // Keep obstacle generation similar, maybe slightly fewer near spawn
    let numObstacles = 0;
     // Only generate random obstacles outside spawn and immediate neighbours
     if (distanceFactor >= 2) {
         numObstacles = Math.floor((chunkNoise(100, 100) + 1) / 2 * (2 + distanceFactor * 0.4) + 1); // Fewer base obstacles, scale slightly slower
     }

     for (let i = 0; i < numObstacles; i++) {
        // Map noise from [-1, 1] to [0, 1] for positioning within the chunk, adding margins
        const normalizedNoiseX = (chunkNoise(200 + i, 200 + i) + 1) / 2;
        const normalizedNoiseY = (chunkNoise(300 + i, 300 + i) + 1) / 2;
        // Map noise from [-1, 1] to [0, 1] for radius calculation
        const normalizedNoiseRadius = (chunkNoise(400 + i, 400 + i) + 1) / 2;

        obstacles.push({
            id: `obs_${chunkId}_${i}`,
            x: chunkX * CHUNK_SIZE + normalizedNoiseX * CHUNK_SIZE * 0.8 + CHUNK_SIZE * 0.1, // Position within 80% of chunk, offset by 10%
            y: chunkY * CHUNK_SIZE + normalizedNoiseY * CHUNK_SIZE * 0.8 + CHUNK_SIZE * 0.1,
             // Slightly smaller obstacles near spawn, scale slower
            radius: normalizedNoiseRadius * 10 + 8 + Math.min(12, distanceFactor * 1.0), // Radius: base 8-18, scales slightly slower with distance up to +12
            type: 'random' // Differentiate from walls
        });
    }


    return { npcs, obstacles };
}

function ensureChunkExists(chunkId) {
  if (!localChunks[chunkId]) {
    const coords = getChunkCoordinates(chunkId);
    localChunks[chunkId] = generateChunkData(coords.x, coords.y);
    saveChunksToLocalStorage(); // Save whenever a new chunk is generated
    // Also check if this newly generated chunk conflicts with remote data
    checkForConflicts(chunkId);
  }
  return localChunks[chunkId];
}


function loadChunksFromLocalStorage() {
  const storedChunks = localStorage.getItem('infiniteBulletHellChunks');
  if (storedChunks) {
    try {
      localChunks = JSON.parse(storedChunks);
       // After loading, initiate sync with currently connected peers
      syncChunksWithPeers();
    } catch (e) {
      console.error("Error parsing chunks from localStorage:", e);
      localChunks = {};
    }
  }
}

function saveChunksToLocalStorage() {
  try {
    // Limit stored chunks to prevent localStorage overflow (e.g., keep N most recent/relevant)
    // For simplicity now, saving all. Consider implementing LRU cache or similar later.
    localStorage.setItem('infiniteBulletHellChunks', JSON.stringify(localChunks));
  } catch (e) {
    console.error("Error saving chunks to localStorage:", e);
     // Handle potential quota exceeded errors
     // Maybe prune old/distant chunks here
  }
}

// --- Chunk Synchronization & Conflict Resolution ---

function syncChunksWithPeers() {
    console.log("Syncing chunks with peers...");
    for (const peerId in room.peers) {
        if (peerId !== room.clientId) {
            syncChunksWithPeer(peerId);
        }
    }
}

function syncChunksWithPeer(peerId) {
    // Request chunk data for chunks visible to the local player from the specific peer
    // This is a simplified approach; a more robust sync would involve exchanging chunk hashes/versions
    console.log(`Requesting visible chunks from ${peerId}`);
    const visibleChunks = getVisibleChunkIds();
    visibleChunks.forEach(chunkId => {
         // Don't request data for chunks we already own locally unless there's a known conflict
        if (!localChunks[chunkId] || activeChunkPortals[chunkId]) {
            console.log(`Requesting chunk ${chunkId} from ${peerId}`);
             room.requestPresenceUpdate(peerId, { type: 'requestChunkData', chunkId });
        } else {
             // Optionally, send hash/version of our local chunk to check for conflicts later
        }
    });
}

function handleChunkDataResponse(chunkId, chunkData, fromClientId) {
    console.log(`Received chunk ${chunkId} data from ${fromClientId}`);
    if (!remoteChunks[chunkId]) {
        remoteChunks[chunkId] = {};
    }
    // Store the received chunk data, associated with the sender
    remoteChunks[chunkId][fromClientId] = chunkData;
    checkForConflicts(chunkId);
}

function checkForConflicts(chunkId) {
    const involvedClientIds = new Set();
    let localDataExists = false;

    // Check if we have local data for this chunk
    if (localChunks[chunkId]) {
        involvedClientIds.add(room.clientId);
        localDataExists = true;
    }

    // Check remote data for this chunk
    if (remoteChunks[chunkId]) {
        Object.keys(remoteChunks[chunkId]).forEach(clientId => {
             if (room.peers[clientId]) { // Only consider currently connected peers
                involvedClientIds.add(clientId);
             }
        });
    }

    // Conflict exists if more than one client has data for the chunk
    if (involvedClientIds.size > 1) {
        console.warn(`Conflict detected for chunk ${chunkId} involving clients:`, Array.from(involvedClientIds));
        if (!activeChunkPortals[chunkId]) {
             activeChunkPortals[chunkId] = Array.from(involvedClientIds);
             updatePortalUI();
             // Initiate resolution process (e.g., simplest: client with lowest ID proposes itself)
             proposeResolution(chunkId);
        } else {
            // Update existing portal participants if needed
            const currentParticipants = new Set(activeChunkPortals[chunkId]);
            let changed = false;
            involvedClientIds.forEach(id => {
                if (!currentParticipants.has(id)) {
                    activeChunkPortals[chunkId].push(id);
                    changed = true;
                }
            });
             // Prune disconnected clients from portal list
            activeChunkPortals[chunkId] = activeChunkPortals[chunkId].filter(id => room.peers[id]);
             if(activeChunkPortals[chunkId].length <= 1) {
                 // Conflict resolved due to disconnects
                delete activeChunkPortals[chunkId];
                changed = true;
                 console.log(`Conflict for chunk ${chunkId} resolved automatically.`);
                 // Ensure local chunk is the active one if it exists and is the only one left
                 if(localChunks[chunkId] && activeChunkPortals[chunkId]?.[0] === room.clientId) {
                    // Nothing to do, local is already active
                 } else if (activeChunkPortals[chunkId]?.length === 1) {
                    // Make the remaining remote chunk the active one locally
                    const winnerId = activeChunkPortals[chunkId][0];
                     if(remoteChunks[chunkId]?.[winnerId]) {
                        localChunks[chunkId] = JSON.parse(JSON.stringify(remoteChunks[chunkId][winnerId])); // Deep copy
                        saveChunksToLocalStorage();
                     }
                 }
                delete remoteChunks[chunkId]; // Clean up remote copies once resolved locally
             }

            if (changed) {
                updatePortalUI();
            }
        }
    } else if (involvedClientIds.size <= 1 && activeChunkPortals[chunkId]) {
         // Conflict potentially resolved if only one participant remains
        console.log(`Conflict for chunk ${chunkId} appears resolved.`);
        delete activeChunkPortals[chunkId];
        updatePortalUI();
         // Ensure the correct chunk is active locally
         const remainingClientId = Array.from(involvedClientIds)[0];
         if(remainingClientId === room.clientId && localChunks[chunkId]) {
            // Local chunk is the winner, ensure no remote overlay
            delete remoteChunks[chunkId];
         } else if (remainingClientId && remoteChunks[chunkId]?.[remainingClientId]) {
             localChunks[chunkId] = JSON.parse(JSON.stringify(remoteChunks[chunkId][remainingClientId])); // Deep copy remote chunk as local truth
             saveChunksToLocalStorage();
             delete remoteChunks[chunkId]; // Clean up now resolved remote copy
         } else if (!remainingClientId && !localChunks[chunkId]) {
             // No one has the chunk anymore? Might happen if everyone disconnected.
             delete remoteChunks[chunkId];
         }
    }
}

function proposeResolution(chunkId) {
    // Simple strategy: client with the lexicographically smallest ID proposes themselves as the winner.
    const participants = activeChunkPortals[chunkId].sort();
    const proposerId = participants[0];

    if (room.clientId === proposerId) {
        console.log(`Proposing self (${room.clientId}) as winner for chunk ${chunkId}`);
        // Broadcast proposal to other participants
        participants.forEach(clientId => {
            if (clientId !== room.clientId) {
                room.requestPresenceUpdate(clientId, {
                    type: 'proposeChunkResolution',
                    chunkId: chunkId,
                    winnerClientId: room.clientId
                });
            }
        });
         // Assume self-proposal is accepted immediately for simplicity in this demo
         // A more robust system would wait for acknowledgements.
         resolveChunkConflict(chunkId, room.clientId);
    }
}


function resolveChunkConflict(chunkId, winnerClientId) {
    console.log(`Resolving conflict for chunk ${chunkId}, winner: ${winnerClientId}`);

    if (!activeChunkPortals[chunkId]) return; // Already resolved or no conflict

    // Determine the winning chunk data
    let winningChunkData = null;
    if (winnerClientId === room.clientId) {
        winningChunkData = localChunks[chunkId];
    } else if (remoteChunks[chunkId] && remoteChunks[chunkId][winnerClientId]) {
        winningChunkData = remoteChunks[chunkId][winnerClientId];
    } else {
        // Winner's data isn't available locally, maybe request it again?
        // For now, log error and potentially re-request if needed.
        console.error(`Cannot resolve conflict for ${chunkId}: Winner ${winnerClientId}'s data not found locally.`);
         if(room.peers[winnerClientId]) {
            room.requestPresenceUpdate(winnerClientId, { type: 'requestChunkData', chunkId });
         }
        return; // Cannot resolve yet
    }

    // Make the winning chunk data the definitive local version
    localChunks[chunkId] = JSON.parse(JSON.stringify(winningChunkData)); // Deep copy

    // Clean up remote data for this chunk and remove the portal
    delete remoteChunks[chunkId];
    delete activeChunkPortals[chunkId];

    // Update UI and save the resolved state
    updatePortalUI();
    saveChunksToLocalStorage();

    console.log(`Conflict for chunk ${chunkId} resolved. Using data from ${winnerClientId}.`);
}


function cleanUpDisconnectedPeerChunks(disconnectedClientId) {
    // Remove the disconnected peer's data from remoteChunks
    for (const chunkId in remoteChunks) {
        if (remoteChunks[chunkId][disconnectedClientId]) {
            delete remoteChunks[chunkId][disconnectedClientId];
             // If the chunk no longer has any remote copies, delete the entry
            if (Object.keys(remoteChunks[chunkId]).length === 0) {
                delete remoteChunks[chunkId];
            }
        }
    }
    // Re-check for conflicts, as the disconnection might resolve some
    Object.keys(activeChunkPortals).forEach(chunkId => {
        const index = activeChunkPortals[chunkId].indexOf(disconnectedClientId);
        if (index > -1) {
            activeChunkPortals[chunkId].splice(index, 1);
            // If only one participant left, the conflict is resolved
            if (activeChunkPortals[chunkId].length <= 1) {
                 const remainingClientId = activeChunkPortals[chunkId][0];
                 console.log(`Conflict for ${chunkId} resolved due to disconnect. Remaining: ${remainingClientId || 'none'}`);
                 if(remainingClientId) {
                    resolveChunkConflict(chunkId, remainingClientId); // Formally resolve
                 } else {
                     // No one left, just remove the portal entry
                     delete activeChunkPortals[chunkId];
                     updatePortalUI();
                     // Decide if local chunk (if exists) should be kept or deleted
                     // If local exists, keep it. Otherwise, no action needed.
                 }
            } else {
                 updatePortalUI(); // Update portal UI if participants changed but conflict remains
            }
        }
    });
     // Also remove the player from the main players list
     delete players[disconnectedClientId];
     updateLeaderboard();
}


// --- Game Logic ---

function updatePlayer(deltaTime) {
    if (localPlayer.dead) return;

    // Health Regeneration
    if (localPlayer.health < localPlayer.maxHealth) {
        localPlayer.health += HEALTH_REGEN_RATE * deltaTime;
        if (localPlayer.health > localPlayer.maxHealth) {
            localPlayer.health = localPlayer.maxHealth;
        }
    }

    let moveX = 0;
    let moveY = 0;
    if (keys['w'] || keys['arrowup']) moveY -= 1;
    if (keys['s'] || keys['arrowdown']) moveY += 1;
    if (keys['a'] || keys['arrowleft']) moveX -= 1;
    if (keys['d'] || keys['arrowright']) moveX += 1;

    const magnitude = Math.sqrt(moveX * moveX + moveY * moveY);
    if (magnitude > 0) {
        localPlayer.vx = (moveX / magnitude) * MAX_SPEED;
        localPlayer.vy = (moveY / magnitude) * MAX_SPEED;
    } else {
        // Simple deceleration
        localPlayer.vx *= 0.9;
        localPlayer.vy *= 0.9;
        if (Math.abs(localPlayer.vx) < 0.1) localPlayer.vx = 0;
        if (Math.abs(localPlayer.vy) < 0.1) localPlayer.vy = 0;
    }

    const nextX = localPlayer.x + localPlayer.vx;
    const nextY = localPlayer.y + localPlayer.vy;

    // Basic Collision with Obstacles (from nearby chunks)
    let collisionX = false;
    let collisionY = false;
    let tempNextX = nextX;
    let tempNextY = nextY;

    const nearbyChunks = getNearbyChunkIds(localPlayer.x, localPlayer.y);
    nearbyChunks.forEach(chunkId => {
        const chunk = localChunks[chunkId]; // Use definitive local data
        if (chunk && chunk.obstacles) {
            chunk.obstacles.forEach(obstacle => {
                if (obstacle.type === 'wall') {
                    // AABB collision for rectangular walls
                    const playerLeft = tempNextX - PLAYER_RADIUS;
                    const playerRight = tempNextX + PLAYER_RADIUS;
                    const playerTop = tempNextY - PLAYER_RADIUS;
                    const playerBottom = tempNextY + PLAYER_RADIUS;

                    const wallLeft = obstacle.x - obstacle.width / 2;
                    const wallRight = obstacle.x + obstacle.width / 2;
                    const wallTop = obstacle.y - obstacle.height / 2;
                    const wallBottom = obstacle.y + obstacle.height / 2;

                    if (playerRight > wallLeft && playerLeft < wallRight && playerBottom > wallTop && playerTop < wallBottom) {
                         // Collision detected - prevent movement into the wall
                         // Find overlap and push back - Simplistic push back for now
                         const overlapX = Math.min(playerRight - wallLeft, wallRight - playerLeft);
                         const overlapY = Math.min(playerBottom - wallTop, wallBottom - playerTop);

                         // Push back on the axis with the *least* overlap
                         if (overlapX < overlapY) {
                             if (localPlayer.x < obstacle.x) tempNextX = wallLeft - PLAYER_RADIUS; // Hit from left
                             else tempNextX = wallRight + PLAYER_RADIUS; // Hit from right
                             collisionX = true;
                         } else {
                             if (localPlayer.y < obstacle.y) tempNextY = wallTop - PLAYER_RADIUS; // Hit from top
                             else tempNextY = wallBottom + PLAYER_RADIUS; // Hit from bottom
                             collisionY = true;
                         }
                    }
                } else if (obstacle.type === 'random' || obstacle.radius) {
                    // Circle collision for random obstacles
                    const dist = Math.sqrt((tempNextX - obstacle.x) ** 2 + (tempNextY - obstacle.y) ** 2);
                    const minRadius = PLAYER_RADIUS + (obstacle.radius || 0); // Use obstacle radius if available
                    if (dist < minRadius) {
                        // collision = true; // Use specific axis collision flags
                        // Simple push-back collision response - More robust needed
                        const overlap = minRadius - dist;
                        const angle = Math.atan2(tempNextY - obstacle.y, tempNextX - obstacle.x);

                        // Push back slightly based on collision angle
                        // This simple approach might stick, better physics needed for smooth slide
                        tempNextX += Math.cos(angle) * overlap * 0.5;
                        tempNextY += Math.sin(angle) * overlap * 0.5;

                        // More simply, just stop movement towards the obstacle
                         // Determine if collision primarily horizontal or vertical
                         if (Math.abs(localPlayer.vx) > Math.abs(localPlayer.vy)) {
                             collisionX = true; // Prioritize stopping X if moving more horizontally
                         } else {
                             collisionY = true; // Prioritize stopping Y if moving more vertically
                         }
                    }
                }
            });
        }
    });


     // Apply movement restrictions based on collisions
     if (!collisionX) {
        localPlayer.x = tempNextX; // Allow X movement if no X collision
     } else {
         localPlayer.vx = 0; // Stop horizontal velocity on X collision
     }
      if (!collisionY) {
         localPlayer.y = tempNextY; // Allow Y movement if no Y collision
     } else {
         localPlayer.vy = 0; // Stop vertical velocity on Y collision
     }


    // Update score based on time survived
    const now = Date.now();
    localPlayer.score = Math.floor((now - START_TIME) / 100); // 1 point per 100ms survived
    scoreElement.textContent = `Score: ${localPlayer.score}`;

    // Update UI Health Bar
    const healthPercentage = Math.max(0, (localPlayer.health / localPlayer.maxHealth) * 100);
    healthBarFill.style.width = `${healthPercentage}%`;
     // Change color based on health
    if (healthPercentage < 30) {
        healthBarFill.style.backgroundColor = '#f44336'; // Red
    } else if (healthPercentage < 60) {
        healthBarFill.style.backgroundColor = '#ff9800'; // Orange
    } else {
        healthBarFill.style.backgroundColor = '#4caf50'; // Green
    }
    healthText.textContent = `Health: ${Math.round(localPlayer.health)}/${localPlayer.maxHealth}`;


    // Send presence update periodically
    if (now - localPlayer.lastUpdateTime > 50) { // Update roughly 20 times/sec
        room.updatePresence({
            x: localPlayer.x,
            y: localPlayer.y,
            score: localPlayer.score,
            health: localPlayer.health,
            maxHealth: localPlayer.maxHealth, // Send max health too, in case it changes later
            dead: localPlayer.dead,
        });
        localPlayer.lastUpdateTime = now;
    }

    // Update camera to follow player
    camera.x = localPlayer.x;
    camera.y = localPlayer.y;
}

function getNearbyChunkIds(x, y, radius = 1) {
    const centerChunkX = Math.floor(x / CHUNK_SIZE);
    const centerChunkY = Math.floor(y / CHUNK_SIZE);
    const nearbyIds = new Set();
    for (let dx = -radius; dx <= radius; dx++) {
        for (let dy = -radius; dy <= radius; dy++) {
            nearbyIds.add(`${centerChunkX + dx}_${centerChunkY + dy}`);
        }
    }
    return nearbyIds;
}

function updateNPCs(deltaTime) {
    const visibleChunks = getVisibleChunkIds();
    const now = Date.now();

    visibleChunks.forEach(chunkId => {
        // Only update NPCs for chunks that are definitively local (not in conflict or resolved to local)
        if (localChunks[chunkId] && (!activeChunkPortals[chunkId] || activeChunkPortals[chunkId]?.[0] === room.clientId)) {
            const chunk = localChunks[chunkId];
             if(!chunk.npcs) chunk.npcs = []; // Ensure npcs array exists

            chunk.npcs.forEach(npc => {
                // Basic movement: Bounce off chunk boundaries (temporary)
                npc.x += npc.vx;
                npc.y += npc.vy;

                const chunkCoords = getChunkCoordinates(chunkId);
                const minX = chunkCoords.x * CHUNK_SIZE;
                const maxX = minX + CHUNK_SIZE;
                const minY = chunkCoords.y * CHUNK_SIZE;
                const maxY = minY + CHUNK_SIZE;

                // More robust boundary collision check
                let bounced = false;
                if (npc.x < minX + npc.radius) { npc.x = minX + npc.radius; npc.vx *= -1; bounced = true; }
                if (npc.x > maxX - npc.radius) { npc.x = maxX - npc.radius; npc.vx *= -1; bounced = true; }
                if (npc.y < minY + npc.radius) { npc.y = minY + npc.radius; npc.vy *= -1; bounced = true; }
                if (npc.y > maxY - npc.radius) { npc.y = maxY - npc.radius; npc.vy *= -1; bounced = true; }

                 // Apply slight random turn on bounce to prevent getting stuck in loops
                 if(bounced) {
                     const angleChange = (Math.random() - 0.5) * 0.5; // +/- 0.25 radians
                     const newAngle = Math.atan2(npc.vy, npc.vx) + angleChange;
                     const speed = Math.sqrt(npc.vx*npc.vx + npc.vy*npc.vy);
                     npc.vx = Math.cos(newAngle) * speed;
                     npc.vy = Math.sin(newAngle) * speed;
                 }


                // Shooter & Dodger NPC logic
                // Check if NPC is allowed to shoot (based on generation) and if cooldown is ready
                const canShoot = (npc.canShoot ?? false) && (now - npc.lastShotTime > npc.shootInterval); // Use the canShoot flag from generation

                if (canShoot) {
                    // Find nearest player (simple approach: local player only for now)
                    const target = localPlayer; // Could be expanded to target closest player in chunk
                    if (!target.dead) {
                        const dx = target.x - npc.x;
                        const dy = target.y - npc.y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                         // Determine bullet speed based on distance factor where NPC spawned
                         const spawnChunkCoords = getChunkCoordinates(chunkId);
                         const spawnDistanceFactor = Math.sqrt(spawnChunkCoords.x**2 + spawnChunkCoords.y**2);
                         let bulletSpeed = 2 + Math.min(3, spawnDistanceFactor * 0.2); // Base speed 2, scales up to 5 further out
                         if (npc.type === 'dodger') bulletSpeed *= 0.8; // Dodgers shoot slightly slower

                        if (dist > 0 && dist < CHUNK_SIZE * 0.7) { // Reduced shooting range slightly
                            const bulletVx = (dx / dist) * bulletSpeed;
                            const bulletVy = (dy / dist) * bulletSpeed;
                            const bulletType = npc.type === 'shooter' ? 'shooter' : 'dodger'; // Assign bullet type
                            const bulletData = {
                                x: npc.x,
                                y: npc.y,
                                vx: bulletVx,
                                vy: bulletVy,
                                ownerChunkX: getChunkCoordinates(chunkId).x,
                                ownerChunkY: getChunkCoordinates(chunkId).y,
                                ownerId: `npc_${npc.id}`, // Identify bullet owner
                                radius: BULLET_RADIUS,
                                type: bulletType // Add type here
                            };
                            bullets.push(bulletData);

                             // Broadcast bullet firing event (only if we own the chunk)
                             room.send({ type: 'bulletFired', bulletData });

                            npc.lastShotTime = now;
                             // Randomize next shot slightly based on original interval
                             npc.shootInterval *= (1 + (Math.random() * 0.2 - 0.1)); // Vary interval by +/- 10% each shot
                             if (npc.shootInterval < 1000) npc.shootInterval = 1000; // Add a minimum interval cap
                        }
                    }
                }
            });
        }
    });
}

function updateBullets(deltaTime) {
    const visibleChunks = getVisibleChunkIds();
    const activeChunkBounds = new Set();
     visibleChunks.forEach(id => activeChunkBounds.add(id));

     // Add adjacent chunks as well, bullets might travel across boundaries
     getVisibleChunkIds().forEach(id => {
        const coords = getChunkCoordinates(id);
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                activeChunkBounds.add(`${coords.x + dx}_${coords.y + dy}`);
            }
        }
    });


    bullets = bullets.filter(bullet => {
        bullet.x += bullet.vx;
        bullet.y += bullet.vy;

        // Check collision with local player
        if (!localPlayer.dead) {
            const dist = Math.sqrt((localPlayer.x - bullet.x) ** 2 + (localPlayer.y - bullet.y) ** 2);
            if (dist < PLAYER_RADIUS + bullet.radius) {
                const damage = bullet.type === 'dodger' ? DODGER_BULLET_DAMAGE : BULLET_DAMAGE;
                takeDamage(damage);
                // Trigger explosion for dodger bullets on player hit
                if (bullet.type === 'dodger') {
                    createExplosion(bullet.x, bullet.y);
                     // Send explosion event to others
                    room.send({ type: 'explosion', x: bullet.x, y: bullet.y });
                }
                return false; // Remove bullet on hit
            }
        }

         // Check collision with obstacles in relevant chunks
         const bulletChunkId = getChunkId(bullet.x, bullet.y);
         const chunk = localChunks[bulletChunkId]; // Use definitive local data
         if(chunk && chunk.obstacles) {
             for(const obstacle of chunk.obstacles) {
                 const dist = Math.sqrt((bullet.x - obstacle.x) ** 2 + (bullet.y - obstacle.y) ** 2);
                 if (dist < bullet.radius + obstacle.radius) {
                     // Trigger explosion for dodger bullets on obstacle hit
                     if (bullet.type === 'dodger') {
                         createExplosion(bullet.x, bullet.y);
                          // Send explosion event to others
                         room.send({ type: 'explosion', x: bullet.x, y: bullet.y });
                     }
                     return false; // Remove bullet on obstacle collision
                 }
             }
         }


        // Remove bullets that go too far out of the active area
        const currentChunkId = getChunkId(bullet.x, bullet.y);
        if (!activeChunkBounds.has(currentChunkId)) {
             // Let bullets travel one chunk beyond visible before removing
             const ownerChunkId = `${bullet.ownerChunkX}_${bullet.ownerChunkY}`;
             const dx = Math.abs(getChunkCoordinates(currentChunkId).x - bullet.ownerChunkX);
             const dy = Math.abs(getChunkCoordinates(currentChunkId).y - bullet.ownerChunkY);
             if (dx > 2 || dy > 2) { // Remove if more than 2 chunks away from origin chunk
                return false;
             }
        }

        return true; // Keep bullet
    });
}

function takeDamage(amount) {
    if (localPlayer.dead) return; // Can't take damage if already dead

    localPlayer.health -= amount;
    console.log(`Player took ${amount} damage, health: ${localPlayer.health}`);

    if (localPlayer.health <= 0) {
        localPlayer.health = 0;
        localPlayer.dead = true;
        localPlayer.vx = 0; // Stop movement
        localPlayer.vy = 0;
        console.log("Player died!");
        // Update presence immediately on death
        room.updatePresence({
            dead: true,
            health: localPlayer.health,
            x: localPlayer.x, // Send final position
            y: localPlayer.y
        });
         // TODO: Implement respawn logic or game over screen
    } else {
         // Update presence with new health if not dead yet
         // This happens in the periodic update in updatePlayer, but could be sent immediately:
         // room.updatePresence({ health: localPlayer.health });
    }

     // Update UI immediately
     const healthPercentage = Math.max(0, (localPlayer.health / localPlayer.maxHealth) * 100);
     healthBarFill.style.width = `${healthPercentage}%`;
      if (healthPercentage < 30) healthBarFill.style.backgroundColor = '#f44336';
      else if (healthPercentage < 60) healthBarFill.style.backgroundColor = '#ff9800';
      else healthBarFill.style.backgroundColor = '#4caf50';
     healthText.textContent = `Health: ${Math.round(localPlayer.health)}/${localPlayer.maxHealth}`;

}

function createExplosion(x, y) {
    explosions.push({ x, y, startTime: Date.now(), maxRadius: EXPLOSION_RADIUS });
}

function updateExplosions(deltaTime) {
    const now = Date.now();
    explosions = explosions.filter(explosion => {
        const age = (now - explosion.startTime) / 1000; // Age in seconds
        return age < EXPLOSION_DURATION; // Keep explosion if duration hasn't passed
    });
}

// --- Rendering ---

function draw() {
    ctx.fillStyle = '#1a1a1a'; // Slightly lighter dark background
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.save();
    // Center camera on player
    ctx.translate(canvas.width / 2 - camera.x, canvas.height / 2 - camera.y);

    // Draw Grid lines for chunks (optional)
    drawChunkGrid();

    // Draw chunks (obstacles, maybe background elements)
    const visibleChunks = getVisibleChunkIds();
    visibleChunks.forEach(chunkId => {
        const chunk = localChunks[chunkId]; // Use definitive local data
        const coords = getChunkCoordinates(chunkId);
        const chunkX = coords.x * CHUNK_SIZE;
        const chunkY = coords.y * CHUNK_SIZE;

        if (chunk) {
             // Draw obstacles
             if(chunk.obstacles) {
                chunk.obstacles.forEach(obstacle => {
                    if (obstacle.type === 'wall') {
                        ctx.fillStyle = '#666'; // Wall color
                        ctx.fillRect(obstacle.x - obstacle.width / 2, obstacle.y - obstacle.height / 2, obstacle.width, obstacle.height);
                    } else if (obstacle.radius) { // Assume circular if radius exists
                        ctx.fillStyle = '#555'; // Random obstacle color
                        ctx.beginPath();
                        const radius = obstacle.radius || 15;
                        if (radius > 0) {
                            ctx.arc(obstacle.x, obstacle.y, radius, 0, Math.PI * 2);
                            ctx.fill();
                        } else {
                             console.warn("Skipping drawing obstacle with invalid radius:", obstacle);
                             ctx.fillStyle = 'magenta';
                             ctx.fillRect(obstacle.x - 5, obstacle.y - 5, 10, 10); // Error marker
                        }
                    }
                });
            }

             // Draw NPCs (only if not spawn chunk, handled by generation)
            if(chunk.npcs && chunk.npcs.length > 0) {
                chunk.npcs.forEach(npc => {
                    ctx.fillStyle = npc.type === 'shooter' ? '#f55' : '#f90'; // Red for shooters, orange for dodgers
                    ctx.beginPath();
                    // Ensure radius is positive before drawing
                     const radius = npc.radius || 8; // Default if missing/falsy
                     if (radius > 0) {
                        ctx.arc(npc.x, npc.y, radius, 0, Math.PI * 2);
                        ctx.fill();
                    } else {
                        console.warn("Skipping drawing NPC with invalid radius:", npc);
                        ctx.fillStyle = 'magenta';
                        ctx.fillRect(npc.x - 5, npc.y - 5, 10, 10); // Error marker
                    }
                });
            }

        } else {
            // Optionally indicate unloaded chunks
            ctx.strokeStyle = '#444';
            ctx.strokeRect(chunkX, chunkY, CHUNK_SIZE, CHUNK_SIZE);
            ctx.fillStyle = '#fff';
            ctx.fillText("Loading...", chunkX + 10, chunkY + 20);
        }

         // Draw portal indication if chunk is in conflict
        if (activeChunkPortals[chunkId]) {
            ctx.strokeStyle = '#0ff'; // Cyan border for conflicting chunks
            ctx.lineWidth = 5;
            ctx.strokeRect(chunkX + 5, chunkY + 5, CHUNK_SIZE - 10, CHUNK_SIZE - 10);
            ctx.lineWidth = 1; // Reset line width
        }
    });

     // Draw Bullets
    bullets.forEach(bullet => {
        ctx.fillStyle = bullet.type === 'dodger' ? '#ff9800' : '#ff0'; // Orange for dodger, Yellow for shooter
        ctx.beginPath();
        const radius = bullet.radius || BULLET_RADIUS;
        if (radius > 0) {
            ctx.arc(bullet.x, bullet.y, radius, 0, Math.PI * 2);
            ctx.fill();
        } else {
            console.warn("Skipping drawing bullet with invalid radius:", bullet);
             ctx.fillStyle = 'magenta';
             ctx.fillRect(bullet.x - 2, bullet.y - 2, 4, 4); // Error marker
        }
    });

     // Draw Explosions
    const now = Date.now();
    explosions.forEach(explosion => {
        const age = (now - explosion.startTime) / 1000; // Age in seconds
        const progress = age / EXPLOSION_DURATION; // 0 to 1

        if (progress < 1) {
            const currentRadius = explosion.maxRadius * progress;
            const opacity = 1 - progress; // Fade out

            ctx.fillStyle = `rgba(255, 152, 0, ${opacity * 0.8})`; // Orange explosion, fading out
            ctx.beginPath();
            ctx.arc(explosion.x, explosion.y, currentRadius, 0, Math.PI * 2);
            ctx.fill();

            // Optional: add inner core
            ctx.fillStyle = `rgba(255, 255, 100, ${opacity * 0.5})`; // Yellowish core
            ctx.beginPath();
            ctx.arc(explosion.x, explosion.y, currentRadius * 0.5, 0, Math.PI * 2);
            ctx.fill();
        }
    });

    // Draw other players
    ctx.font = '10px sans-serif';
    for (const clientId in players) {
        const p = players[clientId];
        if (!p.dead) {
            // Draw player circle
            ctx.fillStyle = getPlayerColor(clientId); // Use a consistent color based on ID
            ctx.beginPath();
            // Ensure radius is positive before drawing
             const radius = PLAYER_RADIUS;
             if (radius > 0) {
                ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
                ctx.fill();
            } else {
                console.warn("Skipping drawing player with invalid radius:", p);
                ctx.fillStyle = 'magenta';
                ctx.fillRect(p.x - 5, p.y - 5, 10, 10); // Error marker
            }

            // Draw avatar image if available
            if (p.avatarUrl) {
                try {
                    const img = new Image();
                    img.src = p.avatarUrl;
                     // Draw image clipped to the circle (more complex, skipping for now)
                    // Simplified: draw small image near player name
                } catch (e) { console.error("Failed to load avatar", e); }
            }

             // Draw Health Bar above player
             drawPlayerHealthBar(ctx, p.x, p.y - PLAYER_RADIUS - 15, p.health, p.maxHealth);

            // Draw username above health bar
            ctx.fillStyle = '#fff';
            ctx.textAlign = 'center';
            ctx.fillText(p.username || clientId.substring(0, 6), p.x, p.y - PLAYER_RADIUS - 20); // Adjusted Y position
        } else {
             // Optionally draw dead players differently (e.g., greyed out 'X')
             ctx.fillStyle = '#888';
             ctx.font = 'bold 15px sans-serif';
             ctx.textAlign = 'center';
             ctx.fillText('X', p.x, p.y + 5);
        }
    }

    // Draw local player
    if (localPlayer.dead) {
         ctx.fillStyle = '#888';
         ctx.font = 'bold 15px sans-serif';
         ctx.textAlign = 'center';
         ctx.fillText('X', localPlayer.x, localPlayer.y + 5);
    } else {
        // Draw player circle
        ctx.fillStyle = getPlayerColor(room.clientId);
        ctx.beginPath();
        // Ensure radius is positive before drawing
        const radius = PLAYER_RADIUS;
        if (radius > 0) {
            ctx.arc(localPlayer.x, localPlayer.y, radius, 0, Math.PI * 2);
            ctx.fill();
        } else {
            console.warn("Skipping drawing local player with invalid radius:", localPlayer);
            ctx.fillStyle = 'magenta';
            ctx.fillRect(localPlayer.x - 5, localPlayer.y - 5, 10, 10); // Error marker
        }

        // Draw Health Bar above player
        drawPlayerHealthBar(ctx, localPlayer.x, localPlayer.y - PLAYER_RADIUS - 15, localPlayer.health, localPlayer.maxHealth);

        // Draw username above health bar
        const myInfo = room.peers[room.clientId];
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.font = '10px sans-serif';
        ctx.fillText(myInfo?.username || 'You', localPlayer.x, localPlayer.y - PLAYER_RADIUS - 20); // Adjusted Y position
    }

    ctx.restore(); // Restore transform
}

function drawPlayerHealthBar(ctx, x, y, health, maxHealth) {
    const barWidth = PLAYER_RADIUS * 3; // Width relative to player size
    const barHeight = 5;
    const healthPercentage = Math.max(0, health) / maxHealth; // Ensure health isn't negative for display

    // Background of the health bar (e.g., dark red or grey)
    ctx.fillStyle = '#555';
    ctx.fillRect(x - barWidth / 2, y - barHeight / 2, barWidth, barHeight);

    // Foreground (current health)
    let healthColor = '#4caf50'; // Green
    if (healthPercentage < 0.3) {
        healthColor = '#f44336'; // Red
    } else if (healthPercentage < 0.6) {
        healthColor = '#ff9800'; // Orange
    }
    ctx.fillStyle = healthColor;
    ctx.fillRect(x - barWidth / 2, y - barHeight / 2, barWidth * healthPercentage, barHeight);

     // Optional: Add a border
    ctx.strokeStyle = '#222';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(x - barWidth / 2, y - barHeight / 2, barWidth, barHeight);
    ctx.lineWidth = 1; // Reset default
}

function drawChunkGrid() {
    const startX = Math.floor((camera.x - canvas.width / 2) / CHUNK_SIZE) * CHUNK_SIZE;
    const startY = Math.floor((camera.y - canvas.height / 2) / CHUNK_SIZE) * CHUNK_SIZE;
    const endX = Math.ceil((camera.x + canvas.width / 2) / CHUNK_SIZE) * CHUNK_SIZE;
    const endY = Math.ceil((camera.y + canvas.height / 2) / CHUNK_SIZE) * CHUNK_SIZE;

    ctx.strokeStyle = '#333'; // Dark grey grid lines
    ctx.lineWidth = 1;

    for (let x = startX; x <= endX; x += CHUNK_SIZE) {
        ctx.beginPath();
        ctx.moveTo(x, startY - CHUNK_SIZE); // Extend lines slightly beyond view
        ctx.lineTo(x, endY + CHUNK_SIZE);
        ctx.stroke();
    }
    for (let y = startY; y <= endY; y += CHUNK_SIZE) {
        ctx.beginPath();
        ctx.moveTo(startX - CHUNK_SIZE, y);
        ctx.lineTo(endX + CHUNK_SIZE, y);
        ctx.stroke();
    }
}

function getPlayerColor(clientId) {
    let hash = 0;
    for (let i = 0; i < clientId.length; i++) {
        hash = clientId.charCodeAt(i) + ((hash << 5) - hash);
    }
    const color = (hash & 0x00FFFFFF).toString(16).toUpperCase();
    return '#' + '00000'.substring(0, 6 - color.length) + color;
}

// --- UI Updates ---

function updateLeaderboard() {
  const allPlayers = [
      { ...localPlayer, username: room.peers[room.clientId]?.username || 'You', avatarUrl: room.peers[room.clientId]?.avatarUrl, clientId: room.clientId },
      ...Object.values(players)
  ];

  allPlayers.sort((a, b) => b.score - a.score); // Sort descending by score

  leaderboardList.innerHTML = ''; // Clear previous list

  allPlayers.slice(0, 10).forEach(p => { // Show top 10
    const li = document.createElement('li');
    const img = document.createElement('img');
    img.src = p.avatarUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${p.username || p.clientId}`; // Default avatar
    img.alt = p.username?.substring(0, 1) || '?';
    img.title = p.username || p.clientId;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = `${p.username || p.clientId.substring(0,6)}: ${p.score}`;
    if (p.dead) {
        nameSpan.style.textDecoration = 'line-through';
        nameSpan.style.color = '#aaa';
    }

    li.appendChild(img);
    li.appendChild(nameSpan);
    leaderboardList.appendChild(li);
  });
}

function updatePortalUI() {
    portalsContainer.innerHTML = ''; // Clear previous buttons

    if (Object.keys(activeChunkPortals).length > 0) {
        portalsContainer.style.display = 'block';
        const title = document.createElement('h4');
        title.textContent = "Chunk Conflicts:";
        portalsContainer.appendChild(title);

        for (const chunkId in activeChunkPortals) {
             // Check if the local player is actually near the conflicted chunk
             const playerChunkId = getChunkId(localPlayer.x, localPlayer.y);
             const nearbyChunks = getNearbyChunkIds(localPlayer.x, localPlayer.y, 1); // Check current and adjacent chunks
             if (nearbyChunks.has(chunkId)) {

                const chunkDiv = document.createElement('div');
                chunkDiv.style.marginBottom = '5px';
                const chunkLabel = document.createElement('span');
                chunkLabel.textContent = `Chunk ${chunkId}: Choose owner -> `;
                chunkDiv.appendChild(chunkLabel);

                activeChunkPortals[chunkId].forEach(clientId => {
                    const button = document.createElement('button');
                    button.classList.add('portal-button');
                    const peerInfo = room.peers[clientId];
                    button.textContent = peerInfo?.username || clientId.substring(0, 6);
                    button.title = `Choose ${peerInfo?.username || clientId}'s version for chunk ${chunkId}`;
                    button.onclick = () => {
                        // When clicked, broadcast the choice to resolve the conflict
                        // Simplification: Directly resolve locally and assume others agree or will resolve similarly.
                        // A robust system needs consensus.
                        console.log(`Manually resolving ${chunkId} to ${clientId}`);
                        resolveChunkConflict(chunkId, clientId);
                        // Broadcast the resolution choice (optional, depends on resolution strategy)
                        // e.g., send a message indicating manual resolution by this client.
                    };
                    chunkDiv.appendChild(button);
                });
                portalsContainer.appendChild(chunkDiv);
            }
        }
    } else {
        portalsContainer.style.display = 'none';
    }
}

// --- Game Loop ---

let lastTimestamp = 0;
function gameLoop(timestamp) {
    const deltaTime = (timestamp - lastTimestamp) / 1000; // Delta time in seconds
    lastTimestamp = timestamp;

    // Ensure chunks around the player are loaded/generated
    const playerChunkId = getChunkId(localPlayer.x, localPlayer.y);
    ensureChunkExists(playerChunkId);
    const nearbyChunks = getNearbyChunkIds(localPlayer.x, localPlayer.y);
    nearbyChunks.forEach(id => ensureChunkExists(id)); // Load/generate nearby chunks

    // Update game state
    updatePlayer(deltaTime);
    updateNPCs(deltaTime);
    updateBullets(deltaTime);
    updateExplosions(deltaTime); // Update explosions

    // Re-check for conflicts periodically or when chunk data changes
    // checkForConflicts is called when new data arrives or is generated.

    // Draw everything
    draw();

    requestAnimationFrame(gameLoop);
}

// --- Start ---
initializeGame();