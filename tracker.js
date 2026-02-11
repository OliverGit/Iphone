// Configuration
const UPDATE_INTERVAL = 1000; // Mise à jour toutes les secondes
const MIN_DISTANCE = 2; // Distance minimale en mètres pour enregistrer un point
const BATCH_SIZE = 10; // Nombre de points avant sauvegarde batch
const SUPABASE_URL = 'https://iclxtruemccjsnfcivfs.supabase.co'; // À remplacer
const SUPABASE_KEY = 'sb_publishable_UZPiiNjtGb-v0XvseJ1rKw_8HqRPhu3'; // À remplacer

//const SEUIL_BAS = -2;
const SEUIL = 2;

// ==================== MODE TEST GPS ====================
const MOCK_GPS = false; // Passer à false pour utilisation réelle

// Route simulée : [lat, lon] à intervalles de 1 seconde
// Accélération forte t=4-5 (+3 m/s²) → bip, freinage fort t=10-11 (-5 m/s²) → bip
const MOCK_ROUTE = [
    [48.856600, 2.352200], // t=0  arrêt (référence)
    [48.856645, 2.352200], // t=1   5 m/s  = 18 km/h
    [48.856708, 2.352200], // t=2   7 m/s  +2 m/s²
    [48.856789, 2.352200], // t=3   9 m/s  +2 m/s²
    [48.856897, 2.352200], // t=4  12 m/s  +3 m/s² → bip accélération
    [48.857032, 2.352200], // t=5  15 m/s  +3 m/s² → bip accélération
    [48.857167, 2.352200], // t=6  15 m/s  constant
    [48.857302, 2.352200], // t=7  15 m/s  constant
    [48.857437, 2.352200], // t=8  15 m/s  constant
    [48.857572, 2.352200], // t=9  15 m/s  constant
    [48.857662, 2.352200], // t=10 10 m/s  -5 m/s² → bip freinage
    [48.857707, 2.352200], // t=11  5 m/s  -5 m/s² → bip freinage
    [48.857725, 2.352200], // t=12  2 m/s  décélération
    [48.857725, 2.352200], // t=13  0 m/s  arrêt
];

const mockGeolocation = {
    _startTime: 0,
    _makePosition(lat, lon, timestamp) {
        return {
            coords: {
                latitude: lat, longitude: lon, altitude: 100, accuracy: 5,
                altitudeAccuracy: null, heading: null, speed: null
            },
            timestamp
        };
    },
    getCurrentPosition(success) {
        this._startTime = Date.now();
        const [lat, lon] = MOCK_ROUTE[0];
        setTimeout(() => success(this._makePosition(lat, lon, this._startTime)), 300);
    },
    watchPosition(success) {
        let i = 1;
        const id = setInterval(() => {
            if (i < MOCK_ROUTE.length) {
                const [lat, lon] = MOCK_ROUTE[i];
                success(mockGeolocation._makePosition(lat, lon, mockGeolocation._startTime + i * 1000));
                i++;
            } else {
                clearInterval(id);
            }
        }, 1000);
        return id;
    },
    clearWatch(id) { clearInterval(id); }
};

const _geo = MOCK_GPS ? mockGeolocation : navigator.geolocation;
// =========================================================

// Variables globales
let map;
let currentMarker;
let trackingActive = false;
let watchId = null;
let pathPoints = [];
let polylines = [];
let lastPosition = null;
let lastSpeed = 0;
let lastVelocityVector = null;
let lastTimestamp = null;
let totalDistance = 0;
let autoCenter = true; // Suivi automatique activé par défaut
let currentSessionId = null;
let pendingBatch = []; // Points en attente de sauvegarde
let audioContext = null;
let lastBeepTime = 0;
const BEEP_COOLDOWN = 2000; // ms entre deux bips

const audio = new Audio('beep.mp3');

// Émettre un bip via Web Audio API
function playBeep(frequency = 880, duration = 0.2) {

    audio.play();
    // if (!audioContext) return;
    // const now = Date.now();
    // if (now - lastBeepTime < BEEP_COOLDOWN) return;
    // lastBeepTime = now;

    // const oscillator = audioContext.createOscillator();
    // const gainNode = audioContext.createGain();
    // oscillator.connect(gainNode);
    // gainNode.connect(audioContext.destination);

    // oscillator.type = 'sine';
    // oscillator.frequency.setValueAtTime(frequency, audioContext.currentTime);
    // gainNode.gain.setValueAtTime(0.5, audioContext.currentTime);
    // gainNode.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + duration);

    // oscillator.start(audioContext.currentTime);
    // oscillator.stop(audioContext.currentTime + duration);
}

// Initialisation de la carte
function initMap() {
    map = L.map('map', {
        zoomControl: true,
        attributionControl: true
    }).setView([48.8566, 2.3522], 13); // Paris par défaut

    // Couche OpenStreetMap
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    // Détecter quand l'utilisateur déplace manuellement la carte
    map.on('dragstart', function() {
        if (trackingActive) {
            autoCenter = false;
            showStatus('Suivi auto désactivé - Appuyez sur votre position pour réactiver', 3000);
        }
    });

    //showStatus('Appuyez sur Démarrer pour commencer le suivi');
}

// Fonction pour obtenir la couleur selon l'accélération longitudinale
function getColorForAcceleration(accel) {
    // accel en m/s²
    if (accel < -SEUIL) return '#ff0000'; // Vert - Fort freinage
    if (accel > SEUIL) return '#ff0000'; // Orange - Accélération

    // if (accel < SEUIL_BAS) return '#ff0000'; // Vert - Fort freinage
    // if (accel < -0.5) return '#90EE90'; // Vert clair - Freinage léger
    // if (accel < 0.5) return '#90EE90'; // Jaune - Vitesse constante

    return '#90EE90'; 
}

// ==================== SUPABASE INTEGRATION ====================

// Générer un UUID pour la session
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Créer une nouvelle session dans Supabase
async function createSession() {
    currentSessionId = generateUUID();

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/sessions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
                session_id: currentSessionId,
                start_time: new Date().toISOString(),
                device_info: navigator.userAgent
            })
        });

        if (!response.ok) {
            console.error('Erreur création session:', await response.text());
        }
    } catch (error) {
        console.error('Erreur Supabase:', error);
    }
}

// Sauvegarder un batch de points dans Supabase
async function saveBatchToSupabase(points) {
    if (!currentSessionId || points.length === 0) return;

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/track_points`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify(points)
        });

        if (response.ok) {
            console.log(`✅ ${points.length} points sauvegardés`);
        } else {
            console.error('Erreur sauvegarde batch:', await response.text());
        }
    } catch (error) {
        console.error('Erreur Supabase batch:', error);
    }
}

// Mettre à jour les statistiques de la session
async function updateSessionStats() {
    if (!currentSessionId) return;

    try {
        const response = await fetch(`${SUPABASE_URL}/rest/v1/sessions?session_id=eq.${currentSessionId}`, {
            method: 'PATCH',
            headers: {
                'Content-Type': 'application/json',
                'apikey': SUPABASE_KEY,
                'Authorization': `Bearer ${SUPABASE_KEY}`,
                'Prefer': 'return=minimal'
            },
            body: JSON.stringify({
                end_time: new Date().toISOString(),
                total_distance_meters: totalDistance,
                total_points: pathPoints.length
            })
        });

        if (!response.ok) {
            console.error('Erreur update session:', await response.text());
        }
    } catch (error) {
        console.error('Erreur Supabase stats:', error);
    }
}

// Ajouter un point au batch et sauvegarder si nécessaire
function addPointToBatch(point) {
    pendingBatch.push(point);

    // Sauvegarder quand le batch est plein
    if (pendingBatch.length >= BATCH_SIZE) {
        saveBatchToSupabase([...pendingBatch]);
        pendingBatch = [];
    }
}

// Calculer la distance entre deux points (formule de Haversine)
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 6371e3; // Rayon de la Terre en mètres
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δφ = (lat2 - lat1) * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;

    const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
             Math.cos(φ1) * Math.cos(φ2) *
             Math.sin(Δλ/2) * Math.sin(Δλ/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));

    return R * c;
}

// Calculer le vecteur vitesse complet entre deux positions
function calculateVelocityVector(point1, point2, deltaTime) {
    const R = 6371000; // Rayon de la Terre en mètres

    const lat1 = point1.lat * Math.PI / 180;
    const lat2 = point2.lat * Math.PI / 180;
    const dLat = (point2.lat - point1.lat) * Math.PI / 180;
    const dLon = (point2.lon - point1.lon) * Math.PI / 180;

    // Déplacement en mètres (composantes Nord-Est)
    const dx_north = R * dLat;
    const dx_east = R * dLon * Math.cos((lat1 + lat2) / 2);

    // Vitesse en m/s (composantes)
    const v_north = dx_north / deltaTime;
    const v_east = dx_east / deltaTime;

    // Module de la vitesse
    const speed_ms = Math.sqrt(v_north * v_north + v_east * v_east);

    // Direction (0° = Nord, 90° = Est, 180° = Sud, 270° = Ouest)
    let heading = Math.atan2(v_east, v_north) * 180 / Math.PI;
    if (heading < 0) heading += 360;

    return {
        speed_ms: speed_ms,
        speed_kmh: speed_ms * 3.6,
        heading_deg: heading,
        velocity_north_ms: v_north,
        velocity_east_ms: v_east,
        distance: Math.sqrt(dx_north * dx_north + dx_east * dx_east)
    };
}

// Calculer l'accélération vectorielle complète
function calculateAccelerationVector(velocity1, velocity2, deltaTime) {
    if (!velocity1 || !velocity2 || deltaTime <= 0) {
        return {
            total_ms2: 0,
            longitudinal_ms2: 0,
            lateral_ms2: 0,
            north_ms2: 0,
            east_ms2: 0
        };
    }

    // Variation de vitesse (composantes)
    const dv_north = velocity2.velocity_north_ms - velocity1.velocity_north_ms;
    const dv_east = velocity2.velocity_east_ms - velocity1.velocity_east_ms;

    // Accélération (m/s²)
    const a_north = dv_north / deltaTime;
    const a_east = dv_east / deltaTime;

    // Module total de l'accélération
    const a_total = Math.sqrt(a_north * a_north + a_east * a_east);

    // Décomposition longitudinale/latérale
    const heading = velocity1.heading_deg * Math.PI / 180;

    // Rotation du repère pour aligner avec la direction du mouvement
    const a_longitudinal = a_north * Math.cos(heading) + a_east * Math.sin(heading);
    const a_lateral = -a_north * Math.sin(heading) + a_east * Math.cos(heading);

    return {
        total_ms2: a_total,
        longitudinal_ms2: a_longitudinal,
        lateral_ms2: a_lateral,
        north_ms2: a_north,
        east_ms2: a_east
    };
}

// Gestion de la position
function handlePosition(position) {
    const lat = position.coords.latitude;
    const lon = position.coords.longitude;
    const altitude = position.coords.altitude;
    const accuracy = position.coords.accuracy;
    const timestamp = position.timestamp;

    // Mettre à jour ou créer le marqueur de position actuelle
    if (!currentMarker) {
        currentMarker = L.circleMarker([lat, lon], {
            radius: 8,
            fillColor: '#007AFF',
            color: 'white',
            weight: 2,
            opacity: 1,
            fillOpacity: 1
        }).addTo(map);

        // Ajouter un cercle de précision
        L.circle([lat, lon], {
            radius: accuracy || 10,
            fillColor: '#007AFF',
            color: '#007AFF',
            weight: 1,
            opacity: 0.2,
            fillOpacity: 0.1
        }).addTo(map);

        map.setView([lat, lon], 17);

        // Rendre le marqueur cliquable pour réactiver le suivi
        currentMarker.on('click', function() {
            autoCenter = true;
            map.setView([lat, lon], map.getZoom());
            showStatus('Suivi automatique réactivé', 2000);
        });
    } else {
        currentMarker.setLatLng([lat, lon]);

        // Centrer automatiquement la carte sur la position si le suivi est actif
        if (autoCenter) {
            map.panTo([lat, lon], {
                animate: true,
                duration: 0.5,
                easeLinearity: 0.25
            });
        }
    }

    // Calculer le vecteur vitesse et l'accélération
    let velocityVector = null;
    let accelerationVector = null;
    let distance = 0;

    if (lastPosition && lastTimestamp) {
        const deltaTime = (timestamp - lastTimestamp) / 1000; // en secondes

        if (deltaTime > 0) {
            // Calculer le vecteur vitesse complet
            velocityVector = calculateVelocityVector(
                lastPosition,
                { lat, lon },
                deltaTime
            );

            distance = velocityVector.distance;

            // Calculer l'accélération vectorielle
            if (lastVelocityVector) {
                accelerationVector = calculateAccelerationVector(
                    lastVelocityVector,
                    velocityVector,
                    deltaTime
                );
            }
        }
    }

    console.log('[GPS] deltaTime:', lastTimestamp ? ((timestamp - lastTimestamp)/1000).toFixed(2)+'s' : 'N/A', '| distance:', distance.toFixed(2)+'m', '| seuil:', MIN_DISTANCE+'m');

    // Enregistrer le point si la distance est suffisante
    if (trackingActive && distance >= MIN_DISTANCE) {
        totalDistance += distance;

        // Créer le point avec toutes les données vectorielles
        const point = {
            session_id: currentSessionId,
            timestamp: new Date(timestamp).toISOString(),
            latitude: lat,
            longitude: lon,
            altitude: altitude,
            accuracy: accuracy,
            // Vecteur vitesse
            speed_ms: velocityVector ? velocityVector.speed_ms : 0,
            speed_kmh: velocityVector ? velocityVector.speed_kmh : 0,
            heading_deg: velocityVector ? velocityVector.heading_deg : 0,
            velocity_north_ms: velocityVector ? velocityVector.velocity_north_ms : 0,
            velocity_east_ms: velocityVector ? velocityVector.velocity_east_ms : 0,
            // Vecteur accélération
            accel_total_ms2: accelerationVector ? accelerationVector.total_ms2 : 0,
            accel_longitudinal_ms2: accelerationVector ? accelerationVector.longitudinal_ms2 : 0,
            accel_lateral_ms2: accelerationVector ? accelerationVector.lateral_ms2 : 0,
            accel_north_ms2: accelerationVector ? accelerationVector.north_ms2 : 0,
            accel_east_ms2: accelerationVector ? accelerationVector.east_ms2 : 0,
            // Métadonnées
            distance_from_previous: distance
        };

        pathPoints.push(point);

        // Ajouter au batch pour sauvegarde Supabase
        addPointToBatch(point);

        // Dessiner le segment si ce n'est pas le premier point
        if (pathPoints.length > 1) {
            const prevPoint = pathPoints[pathPoints.length - 2];
            const accel = accelerationVector ? accelerationVector.longitudinal_ms2 : 0;
            const color = getColorForAcceleration(accel);

            const polyline = L.polyline(
                [[prevPoint.latitude, prevPoint.longitude], [lat, lon]],
                {
                    color: color,
                    weight: 5,
                    opacity: 0.8
                }
            ).addTo(map);

            polylines.push(polyline);
        }

    }

    // Toujours mettre à jour la position de référence pour le prochain calcul
    lastPosition = { lat, lon };
    if (velocityVector) {
        lastVelocityVector = velocityVector;
    }

    // Mettre à jour les informations affichées
    const displaySpeed = velocityVector ? velocityVector.speed_kmh : 0;
    const displayAccel = accelerationVector ? accelerationVector.longitudinal_ms2 : 0;

    // Bip sur dépassement des seuils (±2 m/s²)
    if (trackingActive) {
        if (displayAccel >= SEUIL) {
            playBeep(880, 0.25); // Aigu : forte accélération
        } else if (displayAccel <= -SEUIL) {
            playBeep(220, 0.25); // Grave : fort freinage
        }
    }

    document.getElementById('speed').textContent = displaySpeed.toFixed(1) + ' km/h';
    document.getElementById('acceleration').textContent = displayAccel.toFixed(2) + ' m/s²';
    document.getElementById('distance').textContent = totalDistance >= 1000
        ? (totalDistance / 1000).toFixed(2) + ' km'
        : totalDistance.toFixed(0) + ' m';
    document.getElementById('points').textContent = pathPoints.length;

    lastTimestamp = timestamp;
}

// Gestion des erreurs GPS
function handleError(error) {
    let message = '';
    switch(error.code) {
        case error.PERMISSION_DENIED:
            message = '🚫 Accès GPS refusé\n\n📱 Sur iPhone:\nRéglages > Confidentialité > Localisation > Safari > "Lors de l\'utilisation"\n\nOu effacez l\'historique Safari et réessayez.';
            break;
        case error.POSITION_UNAVAILABLE:
            message = '📡 Signal GPS non disponible. Assurez-vous d\'être en extérieur ou près d\'une fenêtre.';
            break;
        case error.TIMEOUT:
            message = '⏱️ Délai d\'attente GPS dépassé. Vérifiez votre connexion et réessayez.';
            break;
        default:
            message = '❌ Erreur GPS inconnue (' + error.code + ')';
    }
    showStatus(message, 0);

    // Réafficher le bouton démarrer
    document.getElementById('startBtn').style.display = 'block';
    document.getElementById('stopBtn').style.display = 'none';
    trackingActive = false;
}

// Démarrer le suivi
async function startTracking() {
    if (!_geo) {
        showStatus('La géolocalisation n\'est pas supportée par votre navigateur', 0);
        return;
    }

    // Vérifier les permissions d'abord (API Permissions si disponible)
    if (!MOCK_GPS && navigator.permissions) {
        try {
            const result = await navigator.permissions.query({ name: 'geolocation' });

            if (result.state === 'denied') {
                showStatus('GPS bloqué. Allez dans Réglages > Safari > Localisation et autorisez l\'accès', 0);
                return;
            }
        } catch (e) {
            console.log('Permissions API non disponible, on continue...');
        }
    }

    showStatus('Activation du GPS...', 0);

    // Initialiser l'AudioContext depuis un geste utilisateur (requis iOS/Safari)
    if (!audioContext) {
        audioContext = new (window.AudioContext || window['webkitAudioContext'])();
    } else if (audioContext.state === 'suspended') {
        audioContext.resume();
    }

    // Créer une nouvelle session dans Supabase
    await createSession();

    trackingActive = true;
    autoCenter = true; // Réactiver le suivi automatique
    document.getElementById('startBtn').style.display = 'none';
    document.getElementById('stopBtn').style.display = 'block';
    document.getElementById('centerBtn').style.display = 'block';

    const options = {
        enableHighAccuracy: true,
        timeout: 15000,
        maximumAge: 0
    };

    // Première position pour déclencher la demande d'autorisation
    _geo.getCurrentPosition(
        (position) => {
            showStatus(MOCK_GPS ? '[TEST] Simulation démarrée' : 'GPS activé !', 2000);
            handlePosition(position);

            // Puis démarrer le suivi continu
            watchId = _geo.watchPosition(
                handlePosition,
                handleError,
                options
            );
        },
        handleError,
        options
    );
}

// Arrêter le suivi
async function stopTracking() {
    if (watchId) {
        _geo.clearWatch(watchId);
        watchId = null;
    }

    // Sauvegarder les points restants
    if (pendingBatch.length > 0) {
        await saveBatchToSupabase([...pendingBatch]);
        pendingBatch = [];
    }

    // Mettre à jour les stats de la session
    await updateSessionStats();

    trackingActive = false;
    document.getElementById('startBtn').style.display = 'block';
    document.getElementById('stopBtn').style.display = 'none';
    document.getElementById('centerBtn').style.display = 'none';

    showStatus('Suivi GPS arrêté - Session sauvegardée', 2000);
}

// Effacer la trajectoire
function clearTrack() {
    // Supprimer toutes les polylignes
    polylines.forEach(polyline => map.removeLayer(polyline));
    polylines = [];

    // Réinitialiser les données
    pathPoints = [];
    lastPosition = null;
    lastSpeed = 0;
    lastTimestamp = null;
    lastVelocityVector = null;
    totalDistance = 0;

    // Réinitialiser l'affichage
    document.getElementById('distance').textContent = '0 m';
    document.getElementById('points').textContent = '0';
    document.getElementById('acceleration').textContent = '0.0 m/s²';

    showStatus('Trajectoire effacée', 2000);
}

// Afficher un message de statut
function showStatus(message, duration = 0) {
    const statusDiv = document.getElementById('status');
    statusDiv.textContent = message;
    statusDiv.classList.add('show');

    if (duration > 0) {
        setTimeout(() => {
            statusDiv.classList.remove('show');
        }, duration);
    }
}

// Événements des boutons
document.getElementById('startBtn').addEventListener('click', startTracking);
document.getElementById('stopBtn').addEventListener('click', stopTracking);
document.getElementById('clearBtn').addEventListener('click', clearTrack);
document.getElementById('centerBtn').addEventListener('click', function() {
    autoCenter = true;
    if (currentMarker) {
        const pos = currentMarker.getLatLng();
        map.setView(pos, map.getZoom());
        showStatus('Suivi automatique réactivé', 2000);
    }
});

// Vérifier si HTTPS est disponible
function checkHTTPS() {
    if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
        showStatus('⚠️ HTTPS requis pour le GPS. Hébergez ce fichier sur GitHub Pages, Netlify ou Vercel (gratuit)', 0);
        document.getElementById('startBtn').disabled = true;
        document.getElementById('startBtn').style.opacity = '0.5';
        return false;
    }
    return true;
}

// Initialisation au chargement
window.addEventListener('load', () => {
    initMap();
    // if (checkHTTPS()) {
    //     setTimeout(() => {
    //         document.getElementById('status').classList.remove('show');
    //     }, 3000);
    // }
});
