/**
 * Client industries. The code is stored on the client (tenants.industry, constrained in migration 028); the label is for screens.
 * `appointment` is the word a client's team uses for "the thing a lead books" and renames three pipeline stages.
 * `realEstateModules` keeps the property/inventory/viewing screens for real-estate clients only.
 */
export const INDUSTRIES = [
  { code: 'real_estate', label: 'Real estate', appointment: 'Site visit', realEstateModules: true },
  { code: 'healthcare', label: 'Healthcare / clinic', appointment: 'Appointment', realEstateModules: false },
  { code: 'restaurant', label: 'Restaurant / food', appointment: 'Table booking', realEstateModules: false },
  { code: 'finance', label: 'Bank / finance', appointment: 'Meeting', realEstateModules: false },
  { code: 'retail', label: 'Shop / retail', appointment: 'Store visit', realEstateModules: false },
  { code: 'education', label: 'Education / coaching', appointment: 'Counselling session', realEstateModules: false },
  { code: 'beauty_wellness', label: 'Beauty / wellness', appointment: 'Appointment', realEstateModules: false },
  { code: 'automotive', label: 'Automotive', appointment: 'Test drive', realEstateModules: false },
  { code: 'travel', label: 'Travel / hospitality', appointment: 'Consultation', realEstateModules: false },
  { code: 'professional_services', label: 'Professional services', appointment: 'Meeting', realEstateModules: false },
  { code: 'other', label: 'Other', appointment: 'Appointment', realEstateModules: false },
] as const;

export type IndustryCode = (typeof INDUSTRIES)[number]['code'];
export const INDUSTRY_CODES = INDUSTRIES.map((i) => i.code) as unknown as [IndustryCode, ...IndustryCode[]];

export const industryOf = (code: string | null | undefined) => INDUSTRIES.find((i) => i.code === code) ?? INDUSTRIES[INDUSTRIES.length - 1]!;

/**
 * Stage names for a new client. Keys (and therefore rules, reports and automation) never change; only the words do.
 * Real-estate clients keep the recommended names untouched (returns an empty list).
 */
export function stageNamesFor(industry: IndustryCode): Array<{ key: string; name: string }> {
  if (industry === 'real_estate') return [];
  const w = industryOf(industry).appointment;
  return [
    { key: 'new', name: 'New enquiry' },
    { key: 'contact_attempted', name: 'Trying to reach' },
    { key: 'contacted', name: 'In conversation' },
    { key: 'qualified', name: 'Qualified' },
    { key: 'viewing_scheduled', name: `${w} booked` },
    { key: 'viewing_completed', name: `${w} done` },
    { key: 'negotiation', name: 'Considering' },
    { key: 'booking_reserved', name: 'Confirmed' },
  ];
}
