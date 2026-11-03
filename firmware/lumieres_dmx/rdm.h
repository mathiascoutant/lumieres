// RDM (ANSI E1.20) : recherche des appareils présents sur la ligne DMX.
//
// Ce fichier ne dépend pas d'Arduino : l'accès à la ligne passe par un callback, ce qui
// permet de tester l'algorithme sur ordinateur avec des appareils simulés
// (voir firmware/test/rdm_test.cpp).
#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace rdm {

using Uid = uint64_t;  // 48 bits : 16 bits fabricant, 32 bits appareil

const Uid BROADCAST = 0xFFFFFFFFFFFFULL;

const uint8_t CC_DISCOVERY = 0x10;
const uint8_t CC_GET = 0x20;
const uint8_t CC_DISCOVERY_RESPONSE = 0x11;
const uint8_t CC_GET_RESPONSE = 0x21;

const uint16_t PID_DISC_UNIQUE_BRANCH = 0x0001;
const uint16_t PID_DISC_MUTE = 0x0002;
const uint16_t PID_DISC_UN_MUTE = 0x0003;
const uint16_t PID_DEVICE_INFO = 0x0060;
const uint16_t PID_DEVICE_MODEL_DESCRIPTION = 0x0080;
const uint16_t PID_MANUFACTURER_LABEL = 0x0081;
const uint16_t PID_DEVICE_LABEL = 0x0082;
const uint16_t PID_DMX_PERSONALITY_DESCRIPTION = 0x00E1;

const uint8_t RESPONSE_ACK = 0x00;

const size_t MAX_PACKET = 260;
const size_t MAX_DEVICES = 32;
const int MAX_DISCOVERY_STEPS = 2000;  // borne la recherche si la ligne est parasitée
const int RETRIES = 2;
const int UNMUTE_REPEAT = 3;  // une diffusion n'est pas acquittée : on la répète

inline void writeUid(uint8_t* out, Uid uid) {
  for (int i = 0; i < 6; i++) out[i] = (uid >> (8 * (5 - i))) & 0xFF;
}

inline Uid readUid(const uint8_t* in) {
  Uid uid = 0;
  for (int i = 0; i < 6; i++) uid = (uid << 8) | in[i];
  return uid;
}

inline size_t buildRequest(uint8_t* out, Uid dest, Uid src, uint8_t transaction, uint8_t commandClass, uint16_t pid,
                           const uint8_t* data, uint8_t dataLen) {
  const uint8_t length = 24 + dataLen;
  out[0] = 0xCC;
  out[1] = 0x01;
  out[2] = length;
  writeUid(out + 3, dest);
  writeUid(out + 9, src);
  out[15] = transaction;
  out[16] = 1;  // port
  out[17] = 0;  // nombre de messages
  out[18] = 0;  // sous-appareil
  out[19] = 0;
  out[20] = commandClass;
  out[21] = pid >> 8;
  out[22] = pid & 0xFF;
  out[23] = dataLen;
  if (dataLen) memcpy(out + 24, data, dataLen);
  uint16_t sum = 0;
  for (int i = 0; i < length; i++) sum += out[i];
  out[length] = sum >> 8;
  out[length + 1] = sum & 0xFF;
  return length + 2;
}

// Une réponse à DISC_UNIQUE_BRANCH n'est pas un paquet normal : préambule puis UID et
// somme de contrôle, chaque octet étant codé sur deux. Quand deux appareils répondent en
// même temps, ces octets se mélangent et ce décodage échoue.
inline bool decodeDiscovery(const uint8_t* in, size_t n, Uid* uid) {
  size_t start = 0;
  while (start < n && in[start] != 0xAA) {
    if (in[start] != 0xFE && in[start] != 0x00) return false;  // 0x00 : trace du break
    start++;
  }
  if (start >= n || n - start - 1 < 16) return false;
  const uint8_t* e = in + start + 1;
  uint16_t sum = 0;
  uint8_t raw[8];
  for (int i = 0; i < 8; i++) {
    uint8_t a = e[i * 2], b = e[i * 2 + 1];
    if ((a & 0xAA) != 0xAA || (b & 0x55) != 0x55) return false;
    raw[i] = a & b;
    if (i < 6) sum += a + b;
  }
  if (((uint16_t)raw[6] << 8 | raw[7]) != sum) return false;
  *uid = readUid(raw);
  return true;
}

struct Response {
  uint8_t type;
  const uint8_t* data;
  uint8_t dataLen;
};

// Retrouve la réponse attendue dans ce qui a été lu sur la ligne.
inline bool parseResponse(const uint8_t* in, size_t n, Uid self, Uid from, uint8_t transaction, uint8_t commandClass,
                          uint16_t pid, Response* out) {
  for (size_t i = 0; i + 26 <= n; i++) {
    if (in[i] != 0xCC || in[i + 1] != 0x01) continue;
    const uint8_t* p = in + i;
    const uint8_t length = p[2];
    if (length < 24 || i + length + 2 > n) continue;
    uint16_t sum = 0;
    for (int j = 0; j < length; j++) sum += p[j];
    if (((uint16_t)p[length] << 8 | p[length + 1]) != sum) continue;
    if (readUid(p + 3) != self || readUid(p + 9) != from || p[15] != transaction) continue;
    if (p[20] != commandClass || ((uint16_t)p[21] << 8 | p[22]) != pid) continue;
    if (p[23] != length - 24) continue;
    out->type = p[16];
    out->data = p + 24;
    out->dataLen = p[23];
    return true;
  }
  return false;
}

struct Device {
  Uid uid;
  bool hasInfo;
  uint16_t modelId;
  uint16_t footprint;
  uint16_t address;  // 0xFFFF : l'appareil n'a pas d'adresse
  uint8_t personality;
  uint8_t personalityCount;
  char manufacturer[33];
  char model[33];
  char label[33];
  char personalityName[33];
};

// Envoie une requête et lit la réponse. Avec capacity à 0, aucune réponse n'est attendue.
// Renvoie le nombre d'octets lus, 0 si la ligne est restée silencieuse.
typedef size_t (*Transact)(void* context, const uint8_t* request, size_t length, uint8_t* response, size_t capacity);

// Avance d'un petit pas à chaque step() pour laisser passer les trames DMX entre deux.
class Scanner {
 public:
  Scanner(Transact transact, void* context) : transact_(transact), context_(context) {}

  void setSelf(Uid self) { self_ = self; }

  void start() {
    count_ = 0;
    stackSize_ = 0;
    steps_ = 0;
    pass_ = 0;
    truncated_ = false;
    repeat_ = 0;
    infoDevice_ = 0;
    infoItem_ = 0;
    state_ = UNMUTE;
  }

  bool running() const { return state_ != IDLE; }
  bool discovering() const { return state_ == UNMUTE || state_ == DISCOVER; }
  bool truncated() const { return truncated_; }
  bool hasRun() const { return hasRun_; }
  size_t count() const { return count_; }
  const Device& device(size_t i) const { return devices_[i]; }

  void step() {
    switch (state_) {
      case UNMUTE:
        broadcast(PID_DISC_UN_MUTE);
        if (++repeat_ >= UNMUTE_REPEAT) {
          push(0, BROADCAST);
          state_ = DISCOVER;
        }
        break;
      case DISCOVER:
        stepDiscovery();
        break;
      case INFO:
        stepInfo();
        break;
      case FINISH:
        broadcast(PID_DISC_UN_MUTE);
        hasRun_ = true;
        state_ = IDLE;
        break;
      case IDLE:
        break;
    }
  }

 private:
  enum State { IDLE, UNMUTE, DISCOVER, INFO, FINISH };

  void broadcast(uint16_t pid) {
    size_t n = buildRequest(packet_, BROADCAST, self_, transaction_++, CC_DISCOVERY, pid, nullptr, 0);
    transact_(context_, packet_, n, nullptr, 0);
  }

  void push(Uid lower, Uid upper) {
    if (stackSize_ < STACK_SIZE) {
      lower_[stackSize_] = lower;
      upper_[stackSize_] = upper;
      stackSize_++;
    }
  }

  void split(Uid lower, Uid upper) {
    if (lower >= upper) return;
    Uid middle = lower + (upper - lower) / 2;
    push(middle + 1, upper);
    push(lower, middle);
  }

  void stepDiscovery() {
    if (steps_++ >= MAX_DISCOVERY_STEPS) {
      truncated_ = true;
      state_ = INFO;
      return;
    }
    if (stackSize_ == 0) {
      // Un second passage rattrape un appareil dont la réponse aurait été perdue :
      // ceux déjà trouvés restent silencieux, donc il ne coûte presque rien.
      if (pass_++ == 0) {
        push(0, BROADCAST);
      } else {
        state_ = INFO;
      }
      return;
    }
    stackSize_--;
    const Uid lower = lower_[stackSize_], upper = upper_[stackSize_];
    uint8_t range[12];
    writeUid(range, lower);
    writeUid(range + 6, upper);
    size_t n = buildRequest(packet_, BROADCAST, self_, transaction_++, CC_DISCOVERY, PID_DISC_UNIQUE_BRANCH, range, 12);
    size_t got = transact_(context_, packet_, n, buffer_, sizeof(buffer_));
    if (got == 0) return;  // personne dans cette plage

    Uid uid;
    if (!decodeDiscovery(buffer_, got, &uid) || uid < lower || uid > upper) {
      split(lower, upper);  // plusieurs réponses mêlées
      return;
    }
    remember(uid);
    if (mute(uid)) {
      push(lower, upper);  // d'autres appareils se cachaient peut-être derrière lui
    } else {
      split(lower, upper);  // il continuera de répondre : on cherche à côté de lui
    }
    if (count_ >= MAX_DEVICES) {
      truncated_ = true;
      state_ = INFO;
    }
  }

  void remember(Uid uid) {
    for (size_t i = 0; i < count_; i++) {
      if (devices_[i].uid == uid) return;
    }
    if (count_ >= MAX_DEVICES) return;
    Device& d = devices_[count_++];
    memset(&d, 0, sizeof(d));
    d.uid = uid;
    d.address = 0xFFFF;
  }

  bool mute(Uid uid) {
    for (int attempt = 0; attempt <= RETRIES; attempt++) {
      const uint8_t transaction = transaction_++;
      size_t n = buildRequest(packet_, uid, self_, transaction, CC_DISCOVERY, PID_DISC_MUTE, nullptr, 0);
      size_t got = transact_(context_, packet_, n, buffer_, sizeof(buffer_));
      Response r;
      if (parseResponse(buffer_, got, self_, uid, transaction, CC_DISCOVERY_RESPONSE, PID_DISC_MUTE, &r)) return true;
    }
    return false;
  }

  bool get(Uid uid, uint16_t pid, const uint8_t* data, uint8_t dataLen, Response* out) {
    for (int attempt = 0; attempt <= RETRIES; attempt++) {
      const uint8_t transaction = transaction_++;
      size_t n = buildRequest(packet_, uid, self_, transaction, CC_GET, pid, data, dataLen);
      size_t got = transact_(context_, packet_, n, buffer_, sizeof(buffer_));
      if (parseResponse(buffer_, got, self_, uid, transaction, CC_GET_RESPONSE, pid, out)) return out->type == RESPONSE_ACK;
    }
    return false;
  }

  static void copyText(char* out, const uint8_t* in, size_t n) {
    if (n > 32) n = 32;
    memcpy(out, in, n);
    out[n] = 0;
  }

  // Chaque information est demandée à part : beaucoup d'appareils n'en gèrent qu'une
  // partie, et il reste utile de connaître l'adresse d'un appareil qui ne donne pas son nom.
  void stepInfo() {
    if (infoDevice_ >= count_) {
      state_ = FINISH;
      return;
    }
    Device& d = devices_[infoDevice_];
    Response r;
    switch (infoItem_) {
      case 0:
        if (get(d.uid, PID_DEVICE_INFO, nullptr, 0, &r) && r.dataLen >= 16) {
          d.hasInfo = true;
          d.modelId = (uint16_t)r.data[2] << 8 | r.data[3];
          d.footprint = (uint16_t)r.data[10] << 8 | r.data[11];
          d.personality = r.data[12];
          d.personalityCount = r.data[13];
          d.address = (uint16_t)r.data[14] << 8 | r.data[15];
        }
        break;
      case 1:
        if (get(d.uid, PID_MANUFACTURER_LABEL, nullptr, 0, &r)) copyText(d.manufacturer, r.data, r.dataLen);
        break;
      case 2:
        if (get(d.uid, PID_DEVICE_MODEL_DESCRIPTION, nullptr, 0, &r)) copyText(d.model, r.data, r.dataLen);
        break;
      case 3:
        if (get(d.uid, PID_DEVICE_LABEL, nullptr, 0, &r)) copyText(d.label, r.data, r.dataLen);
        break;
      case 4:
        if (d.personality > 0 && get(d.uid, PID_DMX_PERSONALITY_DESCRIPTION, &d.personality, 1, &r) && r.dataLen > 3) {
          copyText(d.personalityName, r.data + 3, r.dataLen - 3);
        }
        break;
    }
    if (++infoItem_ > 4) {
      infoItem_ = 0;
      infoDevice_++;
    }
  }

  static const size_t STACK_SIZE = 128;

  Transact transact_;
  void* context_;
  Uid self_ = 0x7FF000000001ULL;  // plage de fabricant réservée aux prototypes
  State state_ = IDLE;
  bool hasRun_ = false;
  bool truncated_ = false;
  int steps_ = 0;
  int pass_ = 0;
  int repeat_ = 0;
  size_t infoDevice_ = 0;
  int infoItem_ = 0;
  uint8_t transaction_ = 0;
  Device devices_[MAX_DEVICES];
  size_t count_ = 0;
  Uid lower_[STACK_SIZE];
  Uid upper_[STACK_SIZE];
  size_t stackSize_ = 0;
  uint8_t packet_[MAX_PACKET];
  uint8_t buffer_[MAX_PACKET];
};

}  // namespace rdm
