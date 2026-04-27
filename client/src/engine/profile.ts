// ══════════════════════════════════════════════════
//  ZET ROYALE V2 — User Profile Manager
//  State lives on our Node server (fast async API).
// ══════════════════════════════════════════════════

import type { UserProfile, TransitLocation } from '../types/transit';

/** Generate a short unique ID */
function uid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Get default profile */
export function getDefaultProfile(): UserProfile {
  return {
    id: uid(),
    name: 'Default',
    home: null,
    hubs: [],
    destinations: [],
  };
}

/** Load profile from Node API */
export async function loadProfile(): Promise<UserProfile> {
  try {
    const res = await fetch('/api/settings');
    const data = await res.json();
    if (data && data.id) return data as UserProfile;
  } catch (e) {
    console.warn('[PROFILE] Failed to load from API, using default:', e);
  }
  return getDefaultProfile();
}

/** Save profile to Node API */
export async function saveProfile(profile: UserProfile): Promise<void> {
  try {
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profile)
    });
  } catch (e) {
    console.error('[PROFILE] Failed to save to API:', e);
  }
}

/** Update home location */
export async function setHome(profile: UserProfile, lat: number, lon: number, name: string, routes: string[]): Promise<UserProfile> {
  const updated: UserProfile = {
    ...profile,
    home: {
      id: profile.home?.id || 'home_' + uid(),
      name,
      type: 'home',
      lat,
      lon,
      connectedRoutes: routes,
    },
  };
  await saveProfile(updated);
  return updated;
}

/** Add a transit hub (prevents duplicates) */
export async function addHub(profile: UserProfile, name: string, lat: number, lon: number, routes: string[]): Promise<UserProfile> {
  // Prevent duplicates by name
  const exists = profile.hubs.find(h => h.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    // Update routes on existing hub instead of creating a duplicate
    exists.connectedRoutes = [...new Set([...exists.connectedRoutes, ...routes])];
    const updated = { ...profile, hubs: [...profile.hubs] };
    await saveProfile(updated);
    return updated;
  }
  const hub: TransitLocation = {
    id: 'hub_' + uid(),
    name,
    type: 'hub',
    lat,
    lon,
    connectedRoutes: routes,
  };
  const updated: UserProfile = {
    ...profile,
    hubs: [...profile.hubs, hub],
  };
  await saveProfile(updated);
  return updated;
}

/** Add a destination (prevents duplicates) */
export async function addDestination(
  profile: UserProfile, 
  name: string, lat: number, lon: number, 
  routes: string[],
  hubId: string
): Promise<UserProfile> {
  // Prevent duplicates by name
  const exists = profile.destinations.find(d => d.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    exists.connectedRoutes = [...new Set([...exists.connectedRoutes, ...routes])];
    const updated = { ...profile, destinations: [...profile.destinations] };
    await saveProfile(updated);
    return updated;
  }
  const dest: TransitLocation = {
    id: 'dest_' + uid(),
    name,
    type: 'destination',
    lat,
    lon,
    connectedRoutes: routes,
    hubId,
  };
  const updated: UserProfile = {
    ...profile,
    destinations: [...profile.destinations, dest],
  };
  await saveProfile(updated);
  return updated;
}

/** Remove a location by ID */
export async function removeLocation(profile: UserProfile, locationId: string): Promise<UserProfile> {
  const updated: UserProfile = {
    ...profile,
    hubs: profile.hubs.filter(h => h.id !== locationId),
    destinations: profile.destinations.filter(d => d.id !== locationId),
  };
  if (profile.home?.id === locationId) {
    updated.home = null;
  }
  await saveProfile(updated);
  return updated;
}

/** Get all locations as a flat list */
export function getAllLocations(profile: UserProfile | null): TransitLocation[] {
  if (!profile) return [];
  const locs: TransitLocation[] = [];
  if (profile.home) locs.push(profile.home);
  locs.push(...(profile.hubs || []));
  locs.push(...(profile.destinations || []));
  return locs;
}
