# ALŞ08 — P2P Mesaj ve Dosya Aktarımı (PWA)

WebRTC DataChannel üzerinden, **sunucusuz ve uçtan uca şifreli** (DTLS)
çift yönlü metin + dosya transferi.

## Sayfalar
- Web Arayüzü  : `index.html`  → https://KULLANICI.github.io/wtmug-als08/index.html
- Mobil Arayüz : `mobile.html` → https://KULLANICI.github.io/wtmug-als08/mobile.html

## Kullanım
1. Bilgisayarda `index.html` açılır → QR kod görünür.
2. Telefonda `mobile.html` açılır → QR okutulur.
3. Bağlantı otomatik kurulur, sohbet ekranı açılır.
4. Metin yazılır veya 📎 ile dosya seçilir; iki tarafta da ilerleme çubuğu görünür.
5. Fotoğraf/video ön izlenir, diğer dosyalar "İndir" bağlantısıyla kaydedilir.

## Notlar
- Sinyalleşme (SDP/ICE) için PeerJS'in ücretsiz broker'ı kullanılır.
  **Kullanıcı verisi hiçbir sunucuya gitmez/kaydedilmez.**
- Kamera + WebRTC için HTTPS zorunludur (GitHub Pages HTTPS destekler).
- Aynı yöntem iki telefon arasında da çalışır: birinde `index.html`,
  diğerinde `mobile.html` açılır.