pub const SELF_HOSTED_BUILD: bool = match option_env!("CAP_SELF_HOSTED_BUILD") {
    Some(value) => {
        let bytes = value.as_bytes();
        bytes.len() == 4
            && bytes[0] == b't'
            && bytes[1] == b'r'
            && bytes[2] == b'u'
            && bytes[3] == b'e'
    }
    None => false,
};

pub const DEFAULT_SERVER_URL: &str = match option_env!("VITE_SERVER_URL") {
    Some(value) if value.is_empty() => "https://cap.so",
    None => "https://cap.so",
    Some(value) => value,
};

pub const INSTANCE_IDENTIFIER: &str = match option_env!("CAP_INSTANCE_IDENTIFIER") {
    Some(value) if value.is_empty() => "so.cap.desktop",
    None => "so.cap.desktop",
    Some(value) => value,
};

pub const MANAGED_UPDATES_MESSAGE: &str = "Updates for this build are managed by your organization. Install a new TAM Cap package provided by your administrator. This app does not check or install upstream Cap updates.";

pub fn require_automatic_updates() -> Result<(), String> {
    if SELF_HOSTED_BUILD {
        Err(MANAGED_UPDATES_MESSAGE.to_string())
    } else {
        Ok(())
    }
}
