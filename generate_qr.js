const QRCode = require('qrcode');
const path = require('path');

const url = 'http://192.168.29.9:5400/?customer=1';
const outputPath = path.join(__dirname, 'customer-qr.png');

QRCode.toFile(outputPath, url, {
  color: {
    dark: '#39FF14',  // Neon Green
    light: '#0d0d0d'  // Black Background
  },
  width: 600,
  margin: 4
}, function (err) {
  if (err) throw err;
  console.log('QR Code generated at ' + outputPath);
});
