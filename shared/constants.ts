export const CLINIC = {
  name: 'Beatifics Dental Clinic',
  phoneDisplay: '(02) 8775 9896',
  phoneHref: 'tel:+63287759896',
  addressLine1: '0200 E National Highway, Tunasan',
  addressLine2: 'Muntinlupa City, 1773 Metro Manila',
  facebook: 'https://www.facebook.com/BeatificsDentalClinic/',
  instagram: 'https://www.instagram.com/beatificsdental/',
  maps: 'https://maps.app.goo.gl/J59Mw1iJoe874Bd46',
} as const;

export const SERVICES = [
  'Consultation / check-up',
  'Check-ups & Cleaning',
  'Fillings & Restorations',
  'Root Canal Treatment',
  'Crowns, Bridges & Dentures',
  'Braces & Orthodontics',
  'Kids’ dental visit',
  'Dental pain / urgent concern',
] as const;
export type Service = (typeof SERVICES)[number];
