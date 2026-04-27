
import type { UserProfile } from '../types/transit';
import {
  removeLocation,
  getAllLocations
} from '../engine/profile';
import { APP_VERSION } from '../version';

interface SettingsPanelProps {
  profile: UserProfile;
  onProfileChange: (profile: UserProfile) => void;
  showToast: (msg: string) => void;
  onPickOnMap: (mode: 'home' | 'place') => void;
  showHubs: boolean;
  showStops: boolean;
  onToggleHubs: (v: boolean) => void;
  onToggleStops: (v: boolean) => void;
}

export function SettingsPanel({ profile, onProfileChange, showToast, onPickOnMap, showHubs, showStops, onToggleHubs, onToggleStops }: SettingsPanelProps) {

  const allLocations = getAllLocations(profile);

  const handleRemove = async (id: string) => {
    const updated = await removeLocation(profile, id);
    onProfileChange(updated);
  };

  return (
    <div className="settings-overlay">
      {/* Current Profile */}
      <div className="settings-card">
        <div className="settings-title">// MY PLACES</div>

        {allLocations.length === 0 ? (
          <div style={{ color: 'rgba(255,255,255,0.3)', fontSize: '12px', textAlign: 'center', padding: '20px 0' }}>
            No places configured. Set your Home and add places you travel to.
          </div>
        ) : (
          allLocations.map(loc => (
            <div className="location-item" key={loc.id}>
              <div>
                <div className="location-name">{loc.name}</div>
                <div className="location-meta">
                  {loc.lat.toFixed(4)}, {loc.lon.toFixed(4)}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span className={`location-type ${loc.type}`}>
                  {loc.type === 'home' ? '🏠 HOME' : loc.type === 'destination' ? '📍 PLACE' : loc.type.toUpperCase()}
                </span>
                <button
                  className="settings-btn danger"
                  style={{ padding: '4px 8px', fontSize: '9px' }}
                  onClick={() => handleRemove(loc.id)}
                >
                  ✕
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Add New Location */}
      <div className="settings-card">
        <div className="settings-section-title">Add Location</div>
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <button className="settings-btn" onClick={() => onPickOnMap('home')} style={{ borderColor: 'var(--cyan)' }}>
            🎯 Set Home
          </button>
          <button className="settings-btn" onClick={() => onPickOnMap('place')}>
            📍 Add Place
          </button>
        </div>
        <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', marginTop: '8px' }}>
          Clicking these will open the map. You can then drop a pin exactly where you want.
        </div>
      </div>

      {/* Map Layer Toggles */}
      <div className="settings-card">
        <div className="settings-section-title">Map Layers</div>
        

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0' }}>
          <div>
            <div style={{ fontFamily: "'Orbitron', monospace", fontSize: '11px', fontWeight: 700, color: '#fff', letterSpacing: '0.5px' }}>▸ STOPS</div>
            <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.35)', marginTop: '2px' }}>Directional stop arrows (zoom 15+)</div>
          </div>
          <div 
            onClick={() => onToggleStops(!showStops)}
            style={{
              width: '44px', height: '24px', borderRadius: '12px', cursor: 'pointer',
              background: showStops ? 'rgba(0, 255, 213, 0.25)' : 'rgba(255,255,255,0.1)',
              border: `1px solid ${showStops ? 'var(--cyan)' : 'rgba(255,255,255,0.2)'}`,
              position: 'relative', transition: 'all 0.25s ease',
            }}
          >
            <div style={{
              width: '18px', height: '18px', borderRadius: '50%',
              background: showStops ? 'var(--cyan)' : 'rgba(255,255,255,0.3)',
              position: 'absolute', top: '2px',
              left: showStops ? '22px' : '2px',
              transition: 'all 0.25s ease',
              boxShadow: showStops ? '0 0 8px rgba(0,255,213,0.5)' : 'none',
            }} />
          </div>
        </div>
      </div>

      {/* System Info & Debugging */}
      <div className="settings-card" style={{ borderTopColor: 'var(--amber)' }}>
        <div className="settings-section-title">System Info & Debugging</div>
        <div style={{ fontSize: '12px', color: 'rgba(255,255,255,0.4)', marginBottom: '10px' }}>
          Profile stored locally in your browser. No account needed.
        </div>
        
        <button 
          className="settings-btn" 
          style={{ width: '100%', borderColor: 'var(--amber)', color: 'var(--amber)' }}
          onClick={async () => {
            const { getLogsDump } = await import('../engine/telemetry');
            const logs = getLogsDump();
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(logs)
                .then(() => showToast('LOGS COPIED TO CLIPBOARD'))
                .catch(err => showToast('COPY FAILED: ' + err));
            } else {
              try {
                const ta = document.createElement('textarea');
                ta.value = logs;
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                showToast('LOGS COPIED (FALLBACK)');
              } catch (e) {
                showToast('COPY ENTIRELY BLOCKED');
              }
            }
          }}
        >
          📋 Copy Session Logs (Debug)
        </button>
      </div>
      
      {/* Version Display */}
      <div style={{ textAlign: 'center', marginTop: '20px', paddingBottom: '20px', fontSize: '10px', color: 'rgba(255,255,255,0.2)', fontFamily: "'Orbitron', monospace" }}>
        ZET ROYALE v{APP_VERSION}
      </div>
    </div>
  );
}
