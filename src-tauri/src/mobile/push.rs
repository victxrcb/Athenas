//! Web Push: encrypts a short notification for one browser (RFC 8291) and hands it to that browser's push
//! service, signed with this app's own key (VAPID, RFC 8292). The service in the middle cannot read it.
use aws_lc_rs::{
    aead, agreement, hkdf,
    rand::{self, SystemRandom},
    signature::{EcdsaKeyPair, KeyPair, ECDSA_P256_SHA256_FIXED_SIGNING},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::time::Duration;

/// Required by push services as a way to reach the sender; deliberately not a personal address.
const CONTACT: &str = "mailto:push@athenas.invalid";
const TOKEN_SECONDS: i64 = 12 * 3600;
const RECORD_SIZE: u32 = 4096;
/// Room left in one record for the key header, the padding byte and the authentication tag.
const MAX_PAYLOAD: usize = 3_000;
const TIMEOUT: Duration = Duration::from_secs(15);

/// Where a browser receives pushes and the keys that only it can decrypt with.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
}

/// The computer posts to whatever address a device registers, so only real push services are accepted.
fn known_service(host: &str) -> bool {
    host == "fcm.googleapis.com" || host == "web.push.apple.com" || host.ends_with(".push.services.mozilla.com") || host.ends_with(".notify.windows.com")
}

pub fn validate(subscription: &Subscription) -> Result<(), String> {
    const REFUSED: &str = "Este navegador usa um serviço de notificações não reconhecido.";
    if subscription.endpoint.len() > 1_024 {
        return Err(REFUSED.into());
    }
    let url = reqwest::Url::parse(&subscription.endpoint).map_err(|_| REFUSED.to_string())?;
    let plain = url.scheme() == "https" && url.port().is_none() && url.username().is_empty() && url.password().is_none();
    if !plain || !url.host_str().is_some_and(known_service) {
        return Err(REFUSED.into());
    }
    let key = BASE64.decode(&subscription.p256dh).map_err(|_| REFUSED.to_string())?;
    let auth = BASE64.decode(&subscription.auth).map_err(|_| REFUSED.to_string())?;
    if key.len() != 65 || key[0] != 4 || auth.len() != 16 {
        return Err(REFUSED.into());
    }
    Ok(())
}

fn failed<E>(_: E) -> String {
    "Falha ao preparar a notificação.".into()
}

/// A new signing key, as stored in the settings file.
pub fn generate_key() -> Result<String, String> {
    let document = EcdsaKeyPair::generate_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &SystemRandom::new()).map_err(failed)?;
    Ok(BASE64.encode(document.as_ref()))
}

fn key_pair(stored: &str) -> Result<EcdsaKeyPair, String> {
    let bytes = BASE64.decode(stored).map_err(failed)?;
    EcdsaKeyPair::from_pkcs8(&ECDSA_P256_SHA256_FIXED_SIGNING, &bytes).map_err(failed)
}

/// The key the browser needs to accept pushes from this app.
pub fn public_key(stored: &str) -> Result<String, String> {
    Ok(BASE64.encode(key_pair(stored)?.public_key().as_ref()))
}

fn authorization(stored: &str, audience: &str, now: i64) -> Result<String, String> {
    let pair = key_pair(stored)?;
    let header = BASE64.encode(json!({ "typ": "JWT", "alg": "ES256" }).to_string());
    let claims = BASE64.encode(json!({ "aud": audience, "exp": now + TOKEN_SECONDS, "sub": CONTACT }).to_string());
    let signed = format!("{header}.{claims}");
    let signature = pair.sign(&SystemRandom::new(), signed.as_bytes()).map_err(failed)?;
    Ok(format!("vapid t={signed}.{}, k={}", BASE64.encode(signature.as_ref()), BASE64.encode(pair.public_key().as_ref())))
}

struct Length(usize);

impl hkdf::KeyType for Length {
    fn len(&self) -> usize {
        self.0
    }
}

fn derive(salt: &[u8], input: &[u8], info: &[u8], out: &mut [u8]) -> Result<(), String> {
    let key = hkdf::Salt::new(hkdf::HKDF_SHA256, salt).extract(input);
    let info = [info];
    let length = out.len();
    key.expand(&info, Length(length)).map_err(failed)?.fill(out).map_err(failed)
}

/// RFC 8291 with a single `aes128gcm` record. The sender key and salt are fresh for every message.
fn seal(receiver: &[u8], auth: &[u8], sender: &agreement::PrivateKey, salt: [u8; 16], payload: &[u8]) -> Result<Vec<u8>, String> {
    let sender_public = sender.compute_public_key().map_err(failed)?;
    let peer = agreement::UnparsedPublicKey::new(&agreement::ECDH_P256, receiver);
    let shared = agreement::agree(sender, peer, (), |secret| Ok::<_, ()>(secret.to_vec())).map_err(failed)?;
    let info = [b"WebPush: info\0".as_slice(), receiver, sender_public.as_ref()].concat();
    let mut material = [0u8; 32];
    derive(auth, &shared, &info, &mut material)?;
    let mut key = [0u8; 16];
    derive(&salt, &material, b"Content-Encoding: aes128gcm\0", &mut key)?;
    let mut nonce = [0u8; 12];
    derive(&salt, &material, b"Content-Encoding: nonce\0", &mut nonce)?;
    let cipher = aead::LessSafeKey::new(aead::UnboundKey::new(&aead::AES_128_GCM, &key).map_err(failed)?);
    // 2 marks the last (here the only) record.
    let mut record = [payload, &[2]].concat();
    cipher.seal_in_place_append_tag(aead::Nonce::assume_unique_for_key(nonce), aead::Aad::empty(), &mut record).map_err(failed)?;
    let public = sender_public.as_ref();
    Ok([salt.as_slice(), &RECORD_SIZE.to_be_bytes(), &[public.len() as u8], public, &record].concat())
}

fn encrypt(subscription: &Subscription, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_PAYLOAD {
        return Err("A notificação é grande demais.".into());
    }
    let receiver = BASE64.decode(&subscription.p256dh).map_err(failed)?;
    let auth = BASE64.decode(&subscription.auth).map_err(failed)?;
    let sender = agreement::PrivateKey::generate(&agreement::ECDH_P256).map_err(failed)?;
    let mut salt = [0u8; 16];
    rand::fill(&mut salt).map_err(failed)?;
    seal(&receiver, &auth, &sender, salt, payload)
}

#[derive(Debug)]
pub enum Failure {
    /// The browser dropped the subscription; it must be forgotten.
    Gone,
    Other(String),
}

/// Delivers one notification. `topic` lets a newer one replace an older one still waiting for the phone.
pub async fn deliver(key: &str, subscription: &Subscription, payload: &str, topic: &str) -> Result<(), Failure> {
    validate(subscription).map_err(Failure::Other)?;
    let url = reqwest::Url::parse(&subscription.endpoint).map_err(|_| Failure::Gone)?;
    let audience = url.origin().ascii_serialization();
    let body = encrypt(subscription, payload.as_bytes()).map_err(Failure::Other)?;
    let token = authorization(key, &audience, crate::live::now_ms() / 1000).map_err(Failure::Other)?;
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        // The address was checked; a redirect would lead somewhere that was not.
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|error| Failure::Other(error.to_string()))?;
    let topic: String = topic.chars().filter(char::is_ascii_alphanumeric).take(32).collect();
    let response = client
        .post(url)
        .header("Authorization", token)
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        // A notification an hour late is no longer useful.
        .header("TTL", "3600")
        // Without it Android may hold the message while the phone sleeps.
        .header("Urgency", "high")
        .header("Topic", topic)
        .body(body)
        .send()
        .await
        // The address identifies the phone, so it is left out of the message.
        .map_err(|error| Failure::Other(format!("Sem conexão com o serviço de notificações: {}", error.without_url())))?;
    match response.status().as_u16() {
        200..=299 => Ok(()),
        404 | 410 => Err(Failure::Gone),
        status => Err(Failure::Other(format!("O serviço de notificações recusou o envio (HTTP {status})."))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode(value: &str) -> Vec<u8> {
        BASE64.decode(value).unwrap()
    }

    /// The worked example of RFC 8291, appendix A.
    #[test]
    fn encryption_matches_the_published_example() {
        let receiver = decode("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let auth = decode("BTBZMqHH6r4Tts7J_aSIgg");
        let sender = agreement::PrivateKey::from_private_key(&agreement::ECDH_P256, &decode("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let salt: [u8; 16] = decode("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let body = seal(&receiver, &auth, &sender, salt, b"When I grow up, I want to be a watermelon").unwrap();
        assert_eq!(
            BASE64.encode(body),
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN"
        );
    }

    #[test]
    fn the_token_names_the_service_and_is_signed_with_the_stored_key() {
        use aws_lc_rs::signature::{UnparsedPublicKey, ECDSA_P256_SHA256_FIXED};
        let key = generate_key().unwrap();
        let header = authorization(&key, "https://fcm.googleapis.com", 1_000).unwrap();
        let (token, public) = header.strip_prefix("vapid t=").unwrap().split_once(", k=").unwrap();
        assert_eq!(public, public_key(&key).unwrap());
        let (signed, signature) = token.rsplit_once('.').unwrap();
        UnparsedPublicKey::new(&ECDSA_P256_SHA256_FIXED, decode(public)).verify(signed.as_bytes(), &decode(signature)).unwrap();
        let claims: serde_json::Value = serde_json::from_slice(&decode(signed.split_once('.').unwrap().1)).unwrap();
        assert_eq!((claims["aud"].as_str(), claims["exp"].as_i64()), (Some("https://fcm.googleapis.com"), Some(1_000 + TOKEN_SECONDS)));
    }

    #[test]
    fn only_real_push_services_are_accepted() {
        let valid = |endpoint: &str| Subscription {
            endpoint: endpoint.into(),
            p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4".into(),
            auth: "BTBZMqHH6r4Tts7J_aSIgg".into(),
        };
        for endpoint in ["https://fcm.googleapis.com/fcm/send/abc", "https://updates.push.services.mozilla.com/x", "https://db5p.notify.windows.com/w/?token=1"] {
            assert!(validate(&valid(endpoint)).is_ok(), "{endpoint}");
        }
        for endpoint in ["http://fcm.googleapis.com/x", "https://localhost/x", "https://192.168.0.1/x", "https://fcm.googleapis.com.evil.com/x", "https://fcm.googleapis.com:8443/x", "https://user@fcm.googleapis.com/x", "https://evilnotify.windows.com/x"] {
            assert!(validate(&valid(endpoint)).is_err(), "{endpoint}");
        }
        let mut broken = valid("https://fcm.googleapis.com/x");
        broken.auth = "curto".into();
        assert!(validate(&broken).is_err());
    }
}
