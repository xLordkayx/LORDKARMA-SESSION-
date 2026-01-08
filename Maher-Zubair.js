/* LORDKARMA Session Generator - Render/Panel entrypoint */

const app = require('./app');

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`LORDKARMA Session Generator running on port ${PORT}`);
});
