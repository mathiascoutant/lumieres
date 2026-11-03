# Lumières

Pilotage DMX d'une salle des fêtes depuis un iPhone ou un iPad : appareils, contrôle en direct, scènes et rendu 3D de la scène avec la structure BoomTone DJ LT3.

```
iPhone / iPad (Expo Go)  ⇄  serveur Go  ⇄  Art-Net (Wi-Fi)  ⇄  ESP32-S3  ⇄  RS485  ⇄  appareils DMX
                              │
                              └─ MongoDB + copie locale
```

Le serveur calcule l'univers DMX. Le rendu 3D affiche exactement les valeurs envoyées aux appareils.

## Démarrer

Le serveur et le téléphone doivent être sur le même réseau que la carte ESP32.

```bash
cd backend && go run .
```

```bash
cd app && nvm use && npm install && npx expo start
```

Scanne ensuite le QR code avec Expo Go. L'app trouve seule le serveur quand il tourne sur le même ordinateur que `expo start`. Sinon, renseigne son adresse dans Réglages. Node 22.13 ou plus récent est nécessaire.

## Carte ESP32-S3

Carte : Waveshare ESP32-S3-RS485-CAN. Le code est dans `firmware/lumieres_dmx/`.

**Flasher avec PlatformIO :**

```bash
cd firmware && pio run -t upload
```

**Flasher avec l'IDE Arduino :** paquet « esp32 by Espressif » 3.x, carte `ESP32S3 Dev Module`, `USB CDC On Boot` activé, flash 16 Mo.

**Connecter au Wi-Fi :** au premier démarrage, la carte ouvre le réseau `Lumieres-DMX`. Connecte-toi dessus, ouvre `http://192.168.4.1`, puis saisis ton Wi-Fi. Maintenir BOOT 3 secondes au démarrage efface cette configuration.

**Câbler le DMX :**

| Bornier RS485 | XLR DMX |
|---|---|
| A | broche 3 (Data+) |
| B | broche 2 (Data−) |
| GND | broche 1 (masse) |

Si les appareils réagissent de façon incohérente, inverse A et B. Place un bouchon de 120 Ω sur le dernier appareil de la chaîne. Le cavalier 120R de la carte s'active si la carte est en bout de ligne.

Sans signal pendant 5 secondes, la carte passe tous les canaux à 0 : la fumée et le laser ne restent pas allumés si le Wi-Fi tombe.

## Détecter les appareils

Le bouton « Détecter » demande à la ligne DMX quels appareils sont présents, avec le protocole RDM. Pour chaque appareil qui répond, l'app affiche son nom, son adresse et son mode, puis ouvre sa fiche dans les catalogues si elle la trouve.

- Seuls les appareils compatibles RDM répondent. Les autres fonctionnent normalement et s'ajoutent à la main.
- Un splitter DMX classique bloque les réponses : il faut une chaîne directe ou un splitter compatible RDM.
- La détection ne se lance qu'à la demande, car certains appareils lisent mal les paquets RDM et peuvent clignoter pendant la recherche.
- `DMX_GATEWAY_URL` dans `backend/.env` force l'adresse de la carte si elle n'est pas trouvée sur le réseau.

## Ajouter un appareil

1. **Scan du code-barres :** le code est cherché dans UPCitemdb, qui donne le nom du produit (100 scans par jour en gratuit). Ce nom est ensuite cherché dans les catalogues DMX. Un code-barres ne contient aucune donnée DMX, et les marques de revendeur sont souvent absentes de ces bases.
2. **Modèle exact :** recherche dans Open Fixture Library et QLC+, soit environ 2 400 appareils.
3. **Mémorisation :** quand un code n'est pas reconnu, le modèle choisi ensuite lui est associé. Les scans suivants trouvent l'appareil directement.
4. **Modèle absent des catalogues :** crée-le à partir du tableau DMX de sa notice.

Une fois ajouté, l'appareil est enregistré dans la base : le catalogue n'est plus nécessaire pour le piloter.

## Sans internet

Le serveur garde une copie locale dans `backend/data/`. Si MongoDB est injoignable, le spectacle se charge et tourne quand même. Les modifications sont écrites dans MongoDB au retour de la connexion. Seule la recherche de nouveaux appareils demande internet.

## Tests

```bash
cd backend && go test ./...
```

```bash
cd app && npx tsc --noEmit
```

```bash
cd firmware && c++ -std=c++17 -I lumieres_dmx test/rdm_test.cpp -o /tmp/rdm_test && /tmp/rdm_test
```
