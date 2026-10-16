import type { FieldType } from './validate';

/**
 * Starter fields a new client gets for its industry, so the team can capture the right details from day one.
 * They are ordinary fields: the agency can rename, hide or add to them. Real-estate and "other" clients start with none
 * (real estate has its own built-in requirement fields).
 */
export interface StarterField {
  label: string;
  type: FieldType;
  options?: string[];
  helpText?: string;
}

const TIME = ['Morning', 'Afternoon', 'Evening'];
const S = (label: string, type: FieldType, options?: string[], helpText?: string): StarterField => ({ label, type, options, helpText });

export const STARTER_FIELDS: Record<string, StarterField[]> = {
  healthcare: [
    S('Service needed', 'select', ['General consultation', 'Dental', 'Skin / hair', 'Bones / joints', 'Women’s health', 'Children', 'Eye', 'Other']),
    S('Preferred date', 'date'),
    S('Preferred time', 'select', TIME),
    S('Existing patient', 'boolean'),
  ],
  restaurant: [
    S('Party size', 'number', undefined, 'Number of guests'),
    S('Occasion', 'select', ['Birthday', 'Anniversary', 'Family', 'Corporate', 'Casual', 'Other']),
    S('Preferred date', 'date'),
    S('Vegetarian only', 'boolean'),
  ],
  finance: [
    S('Product interest', 'select', ['Home loan', 'Personal loan', 'Car loan', 'Business loan', 'Credit card', 'Savings account', 'Insurance', 'Other']),
    S('Monthly income', 'number'),
    S('Employment type', 'select', ['Salaried', 'Self-employed', 'Business owner', 'Other']),
    S('City', 'text'),
  ],
  retail: [S('Product interest', 'text'), S('Budget', 'number'), S('Preferred store', 'text'), S('Visit date', 'date')],
  education: [
    S('Course interest', 'text'),
    S('Highest qualification', 'select', ['10th', '12th', 'Graduate', 'Postgraduate', 'Other']),
    S('Preferred batch', 'select', ['Morning', 'Evening', 'Weekend', 'Online']),
    S('Parent / guardian name', 'text'),
  ],
  beauty_wellness: [
    S('Service interested in', 'select', ['Hair', 'Skin', 'Spa / massage', 'Bridal', 'Nails', 'Other']),
    S('Preferred date', 'date'),
    S('Preferred time', 'select', TIME),
    S('First visit', 'boolean'),
  ],
  automotive: [
    S('Model interest', 'text'),
    S('Fuel type', 'select', ['Petrol', 'Diesel', 'Electric', 'CNG', 'Hybrid']),
    S('Budget', 'number'),
    S('Test drive wanted', 'boolean'),
    S('Exchange old vehicle', 'boolean'),
  ],
  travel: [
    S('Destination', 'text'),
    S('Travel date', 'date'),
    S('Travellers', 'number'),
    S('Budget', 'number'),
    S('Trip type', 'select', ['Leisure', 'Honeymoon', 'Family', 'Corporate', 'Pilgrimage', 'Other']),
  ],
  professional_services: [
    S('Service needed', 'text'),
    S('Company name', 'text'),
    S('Company size', 'select', ['1–10', '11–50', '51–200', '200+']),
    S('Timeline', 'select', ['Immediately', 'Within a month', '1–3 months', 'Just exploring']),
  ],
};
