// English translation seed. Strings are grouped by feature for easier review;
// new strings should land here first and be translated downstream. The keys
// (not the values) are the contract — never change a key without updating
// every locale, or risk silent fallbacks.
export const en = {
  common: {
    cancel: 'Cancel',
    save: 'Save',
    delete: 'Delete',
    edit: 'Edit',
    add: 'Add',
    done: 'Done',
    loading: 'Loading…',
    error: 'Something went wrong',
    retry: 'Try again',
    close: 'Close',
    yes: 'Yes',
    no: 'No',
    today: 'Today',
    tomorrow: 'Tomorrow',
    yesterday: 'Yesterday',
    daysAgo_one: '{{count}} day ago',
    daysAgo_other: '{{count}} days ago',
  },
  nav: {
    dashboard: 'Dashboard',
    plants: 'Plants',
    tasks: 'Tasks',
    household: 'Household',
    settings: 'Settings',
    signOut: 'Sign out',
  },
  auth: {
    signIn: 'Sign in to your account',
    signInButton: 'Sign in',
    signUp: 'Sign up',
    signUpFree: 'Sign up free',
    email: 'Email address',
    password: 'Password',
    forgotPassword: 'Forgot your password?',
    noAccount: "Don't have an account?",
    invalidEmail: 'Please enter a valid email address',
    passwordRequired: 'Password is required',
  },
  plants: {
    title: 'Plants',
    addPlant: 'Add plant',
    addFirst: 'Add your first plant',
    none: 'No plants yet',
    nameLabel: 'Plant name',
    speciesLabel: 'Species',
    locationLabel: 'Location',
    notesLabel: 'Notes',
    photoLabel: 'Photo (optional)',
    backToPlants: 'Back to plants',
    deleteConfirm: 'Are you sure you want to delete "{{name}}"?',
    generateName: '✨ Generate a fun name',
    identifyFromPhoto: 'Identify from photo',
  },
  tasks: {
    title: 'Tasks',
    addTask: 'Add task',
    snooze: 'Snooze',
    complete: 'Done',
    overdue: 'Overdue',
    types: {
      water: 'Water',
      fertilize: 'Fertilize',
      prune: 'Prune',
      repot: 'Repot',
      custom: 'Custom',
    },
  },
  settings: {
    title: 'Settings',
    description: 'Manage notifications and your household subscription.',
    tabs: {
      notifications: 'Notifications',
      preferences: 'Preferences',
      billing: 'Billing',
      help: 'Help',
    },
    preferences: {
      title: 'Preferences',
      description: 'Customize how the app looks and feels.',
      theme: 'Theme',
      themeLight: 'Light',
      themeDark: 'Dark',
      themeSystem: 'System',
      density: 'Density',
      densityCozy: 'Cozy',
      densityCompact: 'Compact',
      language: 'Language',
    },
  },
  notifications: {
    title: 'Notifications',
    browser: 'Browser',
    email: 'Email',
    sms: 'Text message',
  },
};

// Recursively widen string-literal types to `string` so other locales supply
// translated values, not literal copies of the English text. Without this,
// `as const` would force es.ts into mismatched-literal-type errors.
type DeepString<T> = {
  [K in keyof T]: T[K] extends string ? string : DeepString<T[K]>;
};

export type Translation = DeepString<typeof en>;
