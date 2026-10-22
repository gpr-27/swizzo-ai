// Swiggy's saved addresses carry no coordinates (get_addresses on Food and
// Instamart both return only id / line / tag), but Dineout and Scenes search by
// lat/lng "of the city/area" (dineout.md). So resolve the address's city from
// its line to that city's centre. Unknown city → undefined (the agent asks).

export interface CityPoint {
  city: string;
  latitude: number;
  longitude: number;
}

// [names as they appear in Swiggy address lines, display name, lat, lng]
const CITIES: [string[], string, number, number][] = [
  [['bengaluru', 'bangalore'], 'Bengaluru', 12.9716, 77.5946],
  [['chennai', 'tambaram', 'madras'], 'Chennai', 13.0827, 80.2707],
  [['hyderabad', 'secunderabad'], 'Hyderabad', 17.385, 78.4867],
  [['mumbai', 'bombay', 'thane', 'navi mumbai'], 'Mumbai', 19.076, 72.8777],
  [['new delhi', 'delhi'], 'Delhi', 28.6139, 77.209],
  [['gurugram', 'gurgaon'], 'Gurugram', 28.4595, 77.0266],
  [['noida', 'greater noida'], 'Noida', 28.5355, 77.391],
  [['pune'], 'Pune', 18.5204, 73.8567],
  [['kolkata', 'calcutta'], 'Kolkata', 22.5726, 88.3639],
  [['ahmedabad'], 'Ahmedabad', 23.0225, 72.5714],
  [['jaipur'], 'Jaipur', 26.9124, 75.7873],
  [['kochi', 'cochin', 'ernakulam'], 'Kochi', 9.9312, 76.2673],
  [['thiruvananthapuram', 'trivandrum'], 'Thiruvananthapuram', 8.5241, 76.9366],
  [['coimbatore'], 'Coimbatore', 11.0168, 76.9558],
  [['madurai'], 'Madurai', 9.9252, 78.1198],
  [['tiruchirappalli', 'trichy', 'tiruchi'], 'Tiruchirappalli', 10.7905, 78.7047],
  [['mysuru', 'mysore'], 'Mysuru', 12.2958, 76.6394],
  [['mangaluru', 'mangalore'], 'Mangaluru', 12.9141, 74.856],
  [['visakhapatnam', 'vizag'], 'Visakhapatnam', 17.6868, 83.2185],
  [['vijayawada'], 'Vijayawada', 16.5062, 80.648],
  [['ongole'], 'Ongole', 15.5057, 80.0499],
  [['nuzvid', 'nuzividu', 'nuzvidu'], 'Nuzvid', 16.7889, 80.8467],
  [['chandigarh', 'mohali'], 'Chandigarh', 30.7333, 76.7794],
  [['lucknow'], 'Lucknow', 26.8467, 80.9462],
  [['indore'], 'Indore', 22.7196, 75.8577],
  [['bhopal'], 'Bhopal', 23.2599, 77.4126],
  [['bhubaneswar'], 'Bhubaneswar', 20.2961, 85.8245],
  [['nagpur'], 'Nagpur', 21.1458, 79.0882],
  [['surat'], 'Surat', 21.1702, 72.8311],
  [['vadodara', 'baroda'], 'Vadodara', 22.3072, 73.1812],
  [['patna'], 'Patna', 25.5941, 85.1376],
  [['guwahati'], 'Guwahati', 26.1445, 91.7362],
  [['dehradun'], 'Dehradun', 30.3165, 78.0322],
  [['panaji', 'goa'], 'Goa', 15.4909, 73.8278],
];

// PIN-code district prefixes for lines that name only a suburb ("Manikandam, Tamil Nadu 620012").
const PIN_PREFIX: Record<string, string> = {
  '560': 'Bengaluru', '600': 'Chennai', '500': 'Hyderabad', '400': 'Mumbai', '110': 'Delhi',
  '411': 'Pune', '700': 'Kolkata', '620': 'Tiruchirappalli', '641': 'Coimbatore', '625': 'Madurai',
  '523': 'Ongole', '520': 'Vijayawada', '530': 'Visakhapatnam', '682': 'Kochi', '695': 'Thiruvananthapuram',
};

export function cityPointFor(addressLine: string): CityPoint | undefined {
  // drop the "Name: " prefix Swiggy puts before the address
  const line = addressLine.replace(/^[^:]{1,60}:\s*/, '').toLowerCase();
  // the city comes late in an address line ("…, Trichy Madurai Hwy, Tiruchirappalli, Tamil
  // Nadu") — take the LAST city named, not the first
  let best: { at: number; point: CityPoint } | undefined;
  for (const [names, city, latitude, longitude] of CITIES) {
    for (const n of names) {
      for (const m of line.matchAll(new RegExp(`\\b${n}\\b`, 'g'))) {
        if (!best || (m.index ?? 0) > best.at) best = { at: m.index ?? 0, point: { city, latitude, longitude } };
      }
    }
  }
  if (best) return best.point;
  const pin = line.match(/\b(\d{3})\d{3}\b/)?.[1];
  const byPin = pin ? PIN_PREFIX[pin] : undefined;
  if (byPin) {
    const hit = CITIES.find(([, c]) => c === byPin);
    if (hit) return { city: hit[1], latitude: hit[2], longitude: hit[3] };
  }
  return undefined;
}
