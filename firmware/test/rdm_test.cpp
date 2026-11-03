// Teste la recherche RDM sur ordinateur, avec des appareils simulés sur une fausse ligne.
//
//   c++ -std=c++17 -Wall -Wextra -I lumieres_dmx test/rdm_test.cpp -o /tmp/rdm_test && /tmp/rdm_test

#include <assert.h>
#include <stdio.h>

#include <string>
#include <vector>

#include "rdm.h"

using namespace rdm;

struct FakeDevice {
  Uid uid;
  std::string manufacturer, model, label, personalityName;
  uint16_t address, footprint;
  bool supportsMute = true;
  bool supportsNames = true;
  bool muted = false;
};

struct Line {
  std::vector<FakeDevice> devices;
  int transactions = 0;
  bool noise = false;      // réponses illisibles à chaque question
  int loseFirstReplies = 0;  // perd les N premières réponses de recherche
};

static size_t encodeDiscovery(Uid uid, uint8_t* out) {
  size_t n = 0;
  for (int i = 0; i < 7; i++) out[n++] = 0xFE;
  out[n++] = 0xAA;
  uint8_t raw[6];
  writeUid(raw, uid);
  uint16_t sum = 0;
  for (int i = 0; i < 6; i++) {
    uint8_t a = raw[i] | 0xAA, b = raw[i] | 0x55;
    out[n++] = a;
    out[n++] = b;
    sum += a + b;
  }
  out[n++] = (sum >> 8) | 0xAA;
  out[n++] = (sum >> 8) | 0x55;
  out[n++] = (sum & 0xFF) | 0xAA;
  out[n++] = (sum & 0xFF) | 0x55;
  return n;
}

static size_t reply(const FakeDevice& d, const uint8_t* req, uint8_t type, const std::vector<uint8_t>& data, uint8_t* out) {
  uint8_t cc = req[20] + 1;
  uint16_t pid = (uint16_t)req[21] << 8 | req[22];
  size_t n = buildRequest(out, readUid(req + 9), d.uid, req[15], cc, pid, data.data(), data.size());
  out[16] = type;
  // La somme de contrôle dépend du type de réponse.
  uint16_t sum = 0;
  for (int i = 0; i < out[2]; i++) sum += out[i];
  out[out[2]] = sum >> 8;
  out[out[2] + 1] = sum & 0xFF;
  return n;
}

static std::vector<uint8_t> bytes(const std::string& s) { return std::vector<uint8_t>(s.begin(), s.end()); }

static size_t fakeTransact(void* ctx, const uint8_t* req, size_t, uint8_t* out, size_t cap) {
  Line& line = *static_cast<Line*>(ctx);
  line.transactions++;
  const Uid dest = readUid(req + 3);
  const uint16_t pid = (uint16_t)req[21] << 8 | req[22];

  if (pid == PID_DISC_UN_MUTE && dest == BROADCAST) {
    for (auto& d : line.devices) d.muted = false;
    return 0;
  }
  if (cap == 0) return 0;

  if (pid == PID_DISC_UNIQUE_BRANCH) {
    const Uid lower = readUid(req + 24), upper = readUid(req + 30);
    if (line.noise) {
      out[0] = 0x13;
      out[1] = 0x37;
      return 2;
    }
    std::vector<const FakeDevice*> answering;
    for (auto& d : line.devices) {
      if (!d.muted && d.uid >= lower && d.uid <= upper) answering.push_back(&d);
    }
    if (answering.empty()) return 0;
    if (line.loseFirstReplies > 0) {
      line.loseFirstReplies--;
      return 0;
    }
    size_t n = encodeDiscovery(answering[0]->uid, out);
    if (answering.size() == 1) return n;
    // Collision : les signaux se superposent et les octets deviennent incohérents.
    for (size_t i = 1; i < answering.size(); i++) {
      uint8_t other[32];
      encodeDiscovery(answering[i]->uid, other);
      for (size_t j = 8; j < n; j++) out[j] &= other[j] ^ 0x5A;
    }
    return n;
  }

  for (auto& d : line.devices) {
    if (d.uid != dest) continue;
    switch (pid) {
      case PID_DISC_MUTE:
        if (!d.supportsMute) return 0;
        d.muted = true;
        return reply(d, req, RESPONSE_ACK, {0, 0}, out);
      case PID_DEVICE_INFO: {
        std::vector<uint8_t> info(19, 0);
        info[2] = 0x12;
        info[3] = 0x34;
        info[10] = d.footprint >> 8;
        info[11] = d.footprint & 0xFF;
        info[12] = 2;
        info[13] = 4;
        info[14] = d.address >> 8;
        info[15] = d.address & 0xFF;
        return reply(d, req, RESPONSE_ACK, info, out);
      }
      case PID_MANUFACTURER_LABEL:
        if (!d.supportsNames) return reply(d, req, 2, {0, 0}, out);
        return reply(d, req, RESPONSE_ACK, bytes(d.manufacturer), out);
      case PID_DEVICE_MODEL_DESCRIPTION:
        if (!d.supportsNames) return reply(d, req, 2, {0, 0}, out);
        return reply(d, req, RESPONSE_ACK, bytes(d.model), out);
      case PID_DEVICE_LABEL:
        if (!d.supportsNames) return reply(d, req, 2, {0, 0}, out);
        return reply(d, req, RESPONSE_ACK, bytes(d.label), out);
      case PID_DMX_PERSONALITY_DESCRIPTION: {
        if (!d.supportsNames) return reply(d, req, 2, {0, 0}, out);
        std::vector<uint8_t> desc = {req[24], (uint8_t)(d.footprint >> 8), (uint8_t)d.footprint};
        auto text = bytes(d.personalityName);
        desc.insert(desc.end(), text.begin(), text.end());
        return reply(d, req, RESPONSE_ACK, desc, out);
      }
    }
    return 0;
  }
  return 0;
}

static Scanner* runScan(Line& line) {
  static Scanner* scanner = nullptr;
  delete scanner;
  scanner = new Scanner(fakeTransact, &line);
  scanner->start();
  int guard = 0;
  while (scanner->running()) {
    scanner->step();
    assert(++guard < 200000);
  }
  return scanner;
}

static const Device* find(const Scanner& s, Uid uid) {
  for (size_t i = 0; i < s.count(); i++) {
    if (s.device(i).uid == uid) return &s.device(i);
  }
  return nullptr;
}

static void testNoDevice() {
  Line line;
  Scanner* s = runScan(line);
  assert(s->count() == 0 && !s->truncated() && s->hasRun());
  assert(line.transactions < 12);  // une ligne sans RDM répond vite
}

static void testOneDevice() {
  Line line;
  line.devices.push_back({0x414C00001234ULL, "ADJ", "5PX HEX", "Face gauche", "8 Channel", 12, 8});
  Scanner* s = runScan(line);
  assert(s->count() == 1);
  const Device* d = find(*s, 0x414C00001234ULL);
  assert(d && d->hasInfo && d->address == 12 && d->footprint == 8 && d->personality == 2 && d->personalityCount == 4);
  assert(std::string(d->manufacturer) == "ADJ" && std::string(d->model) == "5PX HEX");
  assert(std::string(d->label) == "Face gauche" && std::string(d->personalityName) == "8 Channel");
  assert(!line.devices[0].muted);  // tout est rendu à la fin
}

static void testCollisionsFindEveryone() {
  Line line;
  // Des UID très proches obligent à descendre tout l'arbre, les autres à le couper tôt.
  const std::vector<Uid> uids = {0x414C00001234ULL, 0x414C00001235ULL, 0x414C00001236ULL, 0x000000000001ULL,
                                 0xFFFFFFFFFFFEULL, 0x7A7000000042ULL, 0x414C80000000ULL};
  for (Uid u : uids) line.devices.push_back({u, "M", "X", "", "", 1, 3});
  Scanner* s = runScan(line);
  assert(s->count() == uids.size() && !s->truncated());
  for (Uid u : uids) assert(find(*s, u));
  assert(line.transactions < MAX_DISCOVERY_STEPS);
}

static void testDeviceWithoutNames() {
  Line line;
  FakeDevice d{0x123400000001ULL, "", "", "", "", 40, 6};
  d.supportsNames = false;
  line.devices.push_back(d);
  Scanner* s = runScan(line);
  const Device* found = find(*s, d.uid);
  assert(found && found->address == 40 && found->footprint == 6);
  assert(found->manufacturer[0] == 0 && found->model[0] == 0 && found->personalityName[0] == 0);
}

static void testDeviceThatNeverMutes() {
  Line line;
  FakeDevice stubborn{0x100000000001ULL, "A", "B", "", "", 1, 1};
  stubborn.supportsMute = false;
  line.devices.push_back(stubborn);
  line.devices.push_back({0x200000000002ULL, "C", "D", "", "", 2, 1});
  Scanner* s = runScan(line);  // ne doit surtout pas tourner sans fin
  assert(find(*s, stubborn.uid));
  assert(find(*s, 0x200000000002ULL));
}

static void testNoisyLineStops() {
  Line line;
  line.noise = true;
  Scanner* s = runScan(line);
  assert(s->count() == 0 && s->truncated());
}

static void testLostReplyIsCaughtBySecondPass() {
  Line line;
  line.devices.push_back({0x414C00000001ULL, "M", "X", "", "", 1, 3});
  line.loseFirstReplies = 1;
  Scanner* s = runScan(line);
  assert(s->count() == 1);
}

static void testDecodeRejectsCorruption() {
  uint8_t buf[32];
  size_t n = encodeDiscovery(0x414C00001234ULL, buf);
  Uid uid;
  assert(decodeDiscovery(buf, n, &uid) && uid == 0x414C00001234ULL);
  buf[12] ^= 0x10;
  assert(!decodeDiscovery(buf, n, &uid));
  assert(!decodeDiscovery(buf, 5, &uid));
}

static void testRequestLayout() {
  uint8_t out[64];
  size_t n = buildRequest(out, BROADCAST, 0x7FF000000001ULL, 7, CC_DISCOVERY, PID_DISC_MUTE, nullptr, 0);
  assert(n == 26 && out[0] == 0xCC && out[1] == 0x01 && out[2] == 24 && out[15] == 7 && out[20] == 0x10 && out[22] == 2);
  uint16_t sum = 0;
  for (int i = 0; i < 24; i++) sum += out[i];
  assert(out[24] == sum >> 8 && out[25] == (sum & 0xFF));
}

int main() {
  testRequestLayout();
  testDecodeRejectsCorruption();
  testNoDevice();
  testOneDevice();
  testCollisionsFindEveryone();
  testDeviceWithoutNames();
  testDeviceThatNeverMutes();
  testNoisyLineStops();
  testLostReplyIsCaughtBySecondPass();
  puts("rdm: tous les tests passent");
  return 0;
}
