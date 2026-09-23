// Catalog of everything a guest would normally phone reception for.
// Each service maps to a department (who handles it on the staff dashboard)
// and declares the form fields the guest fills in. The guest UI renders
// these fields dynamically and the server validates submissions against them.
//
// A field with `showIf: { field, equals }` only applies when another field has
// that value; it is hidden in the form, required when shown (if `required`),
// and dropped from the submission otherwise.

const DEPARTMENTS = {
  housekeeping: 'Housekeeping',
  laundry: 'Laundry',
  kitchen: 'Room Service / Kitchen',
  maintenance: 'Maintenance',
  front_desk: 'Front Desk',
};

const SERVICES = [
  {
    id: 'room_cleaning',
    name: 'Room Cleaning',
    icon: '🧹',
    department: 'housekeeping',
    description: 'Request your room to be cleaned.',
    fields: [
      {
        name: 'when',
        label: 'When should we come?',
        type: 'select',
        options: ['As soon as possible', 'Within 1 hour', 'While I am out (anytime today)', 'At a specific time'],
        required: true,
      },
      {
        name: 'time',
        label: 'Preferred time',
        type: 'time',
        required: true,
        showIf: { field: 'when', equals: 'At a specific time' },
      },
      {
        name: 'type',
        label: 'Type of cleaning',
        type: 'select',
        options: ['Full cleaning', 'Quick tidy-up', 'Change bed linen only', 'Empty bins only'],
        required: true,
      },
    ],
  },
  {
    id: 'amenities',
    name: 'Towels & Amenities',
    icon: '🧴',
    department: 'housekeeping',
    description: 'Extra towels, toiletries, pillows, blankets or water.',
    fields: [
      {
        name: 'items',
        label: 'What do you need?',
        type: 'checklist',
        options: [
          'Bath towels',
          'Hand towels',
          'Soap',
          'Shampoo & conditioner',
          'Toothbrush kit',
          'Shaving kit',
          'Extra pillow',
          'Extra blanket',
          'Drinking water',
          'Toilet paper',
          'Hangers',
          'Iron & ironing board',
        ],
        required: true,
      },
      { name: 'quantity', label: 'Quantity (each)', type: 'number', min: 1, max: 10, required: false },
    ],
  },
  {
    id: 'laundry',
    name: 'Laundry',
    icon: '👕',
    department: 'laundry',
    description: 'Laundry pickup, dry cleaning or ironing.',
    fields: [
      {
        name: 'service',
        label: 'Service',
        type: 'select',
        options: ['Wash & fold', 'Wash & iron', 'Dry cleaning', 'Ironing only'],
        required: true,
      },
      {
        name: 'speed',
        label: 'Delivery speed',
        type: 'select',
        options: ['Standard (next day)', 'Express (same day)'],
        required: true,
      },
      { name: 'pieces', label: 'Approximate number of pieces', type: 'number', min: 1, max: 100, required: false },
    ],
  },
  {
    id: 'room_service',
    name: 'Food & Drinks',
    icon: '🍽️',
    department: 'kitchen',
    description: 'Order food or drinks to your room.',
    fields: [
      { name: 'order', label: 'What would you like to order?', type: 'textarea', maxLength: 1000, required: true },
      { name: 'guests', label: 'Number of people', type: 'number', min: 1, max: 20, required: false },
    ],
  },
  {
    id: 'maintenance',
    name: 'Something Not Working',
    icon: '🔧',
    department: 'maintenance',
    description: 'AC, plumbing, lights, TV, Wi-Fi or anything broken.',
    fields: [
      {
        name: 'category',
        label: 'What is the problem with?',
        type: 'select',
        options: ['AC / Heating', 'Plumbing / Water', 'Electrical / Lights', 'TV', 'Wi-Fi / Internet', 'Door / Lock', 'Other'],
        required: true,
      },
      { name: 'description', label: 'Describe the problem', type: 'textarea', maxLength: 1000, required: false },
    ],
  },
  {
    id: 'wake_up_call',
    name: 'Wake-up Call',
    icon: '⏰',
    department: 'front_desk',
    description: 'Schedule a wake-up call.',
    fields: [
      { name: 'time', label: 'Wake-up time', type: 'time', required: true },
      {
        name: 'day',
        label: 'Day',
        type: 'select',
        options: ['Tomorrow', 'Today'],
        required: true,
      },
    ],
  },
  {
    id: 'late_checkout',
    name: 'Late Checkout',
    icon: '🕐',
    department: 'front_desk',
    description: 'Request to check out later than usual.',
    fields: [{ name: 'time', label: 'Requested checkout time', type: 'time', required: true }],
  },
  {
    id: 'transport',
    name: 'Taxi / Transport',
    icon: '🚕',
    department: 'front_desk',
    description: 'Book a taxi or airport transfer.',
    fields: [
      {
        name: 'type',
        label: 'Type',
        type: 'select',
        options: ['Taxi', 'Airport transfer', 'Car rental enquiry'],
        required: true,
      },
      { name: 'time', label: 'Pickup time', type: 'time', required: true },
      { name: 'destination', label: 'Destination', type: 'text', maxLength: 200, required: false },
      { name: 'passengers', label: 'Passengers', type: 'number', min: 1, max: 20, required: false },
    ],
  },
  {
    id: 'message',
    name: 'Message Reception',
    icon: '💬',
    department: 'front_desk',
    description: 'Anything else? Send a message to the front desk.',
    fields: [{ name: 'message', label: 'Your message', type: 'textarea', maxLength: 1000, required: true }],
  },
];

const SERVICE_MAP = new Map(SERVICES.map((s) => [s.id, s]));

const STATUSES = ['new', 'acknowledged', 'in_progress', 'completed', 'cancelled'];
const OPEN_STATUSES = ['new', 'acknowledged', 'in_progress'];

// Validates guest-submitted details against the service's field definitions.
// Returns { ok: true, details } with only known, normalised fields, or
// { ok: false, error }.
function validateDetails(service, input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const details = {};

  for (const field of service.fields) {
    if (field.showIf && raw[field.showIf.field] !== field.showIf.equals) continue;
    let value = raw[field.name];
    const empty =
      value === undefined ||
      value === null ||
      value === '' ||
      (Array.isArray(value) && value.length === 0);

    if (empty) {
      if (field.required) return { ok: false, error: `"${field.label}" is required.` };
      continue;
    }

    switch (field.type) {
      case 'select':
        if (typeof value !== 'string' || !field.options.includes(value)) {
          return { ok: false, error: `Invalid choice for "${field.label}".` };
        }
        break;
      case 'checklist':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && field.options.includes(v))) {
          return { ok: false, error: `Invalid choice for "${field.label}".` };
        }
        value = [...new Set(value)];
        break;
      case 'number': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < (field.min ?? 0) || n > (field.max ?? 1000)) {
          return { ok: false, error: `"${field.label}" must be a whole number between ${field.min ?? 0} and ${field.max ?? 1000}.` };
        }
        value = n;
        break;
      }
      case 'time':
        if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) {
          return { ok: false, error: `"${field.label}" must be a valid time (HH:MM).` };
        }
        break;
      case 'text':
      case 'textarea': {
        if (typeof value !== 'string') return { ok: false, error: `"${field.label}" must be text.` };
        value = value.trim();
        const max = field.maxLength ?? 500;
        if (value.length > max) return { ok: false, error: `"${field.label}" is too long (max ${max} characters).` };
        if (!value) {
          if (field.required) return { ok: false, error: `"${field.label}" is required.` };
          continue;
        }
        break;
      }
      default:
        return { ok: false, error: `Unsupported field type ${field.type}.` };
    }
    details[field.name] = value;
  }

  return { ok: true, details };
}

// Human-readable one-line summary of a request's details for dashboards.
function summarize(service, details) {
  if (!service) return '';
  return service.fields
    .filter((f) => details[f.name] !== undefined)
    .map((f) => {
      const v = details[f.name];
      return `${f.label.replace(/[?:]$/, '')}: ${Array.isArray(v) ? v.join(', ') : v}`;
    })
    .join(' · ');
}

module.exports = { DEPARTMENTS, SERVICES, SERVICE_MAP, STATUSES, OPEN_STATUSES, validateDetails, summarize };
