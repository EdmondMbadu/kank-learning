/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./src/**/*.{html,ts}", // scan all templates & inline classes
  ],
  theme: {
    extend: {},
  },
  darkMode: 'class', // optional: use 'class' for dark mode toggling
  // If you're keeping Bootstrap and want to avoid CSS reset conflicts:
  // corePlugins: { preflight: false },
};
