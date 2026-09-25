const app = require('../src/app');

module.exports = app;

if (require.main === module) {
  const port = Number.parseInt(process.env.PORT, 10) || 3000;

  app.listen(port, () => {
    console.log(`DeliveryIQ is listening on http://localhost:${port}`);
  });
}
