// Names and figures the result shows: what each kind of restricted site
// is called, and the clearances and reserve quoted in the text.

export var HAZARD_TYPE_LABEL = {
  school: 'School', kindergarten: 'Kindergarten', hospital: 'Hospital', playground: 'Playground',
  nursing_home: 'Nursing home', university: 'University/college', power: 'Power facility',
  airport: 'Airport/airfield', heliport: 'Heliport', prison: 'Prison', embassy: 'Embassy', military: 'Military site', military_airfield: 'Military airfield',
  building: 'Tall building'
};

export var BUILDING_HEIGHT_SAFETY_MARGIN_M = 20;  // flown above a building climbed over
export var BUILDING_LATERAL_SAFETY_MARGIN_M = 30; // kept from one routed around
export var BATTERY_RESERVE_PCT = 20;
export var SPEC_FLIGHT_TIME_FACTOR = 0.85;        // rated flight time -> what's planned with

export function fmtPct(p){
  if (!isFinite(p)) return '—';
  return (p < 1 ? '<1' : p.toFixed(0)) + '%';
}
