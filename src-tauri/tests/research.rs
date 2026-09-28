use evidence_desk::{
    backup,
    case::{Case, Settings},
    research,
};
use serde_json::json;

fn setup() -> (tempfile::TempDir, Case) {
    let dir = tempfile::tempdir().unwrap();
    let case = Case::create(&dir.path().join("test.ledcase"), "Synthetic case").unwrap();
    (dir, case)
}

fn go_online(case: &mut Case) {
    case.save_settings(Settings { offline: false, allow_text: true, allow_images: false, model: "test-model".into() }).unwrap();
}

#[test]
fn research_browser_is_off_by_default_and_refused_while_offline() {
    let (_dir, mut case) = setup();
    assert!(!research::enabled(&case));
    assert!(research::grant(&case).unwrap().is_none());
    let error = research::set_grant(&mut case, true, &[]).unwrap_err().to_string();
    assert!(error.contains("offline"), "{error}");
    assert!(!research::enabled(&case));
    // Switching off is always allowed.
    research::set_grant(&mut case, false, &[]).unwrap();
    assert!(!research::enabled(&case));
}

#[test]
fn research_toggle_is_revisioned_audited_and_validates_sign_in_hosts() {
    let (_dir, mut case) = setup();
    go_online(&mut case);
    let first = research::set_grant(&mut case, true, &["Login.Firm.Example.".into(), "login.firm.example".into()]).unwrap();
    assert!(first.enabled && research::enabled(&case));
    assert_eq!(first.revision, 1);
    assert_eq!(first.sso_hosts, ["login.firm.example"]);
    assert_eq!(first.routes, ["api_keys"]);
    assert_eq!(first.approval_mode, "autonomous");
    let second = research::set_grant(&mut case, false, &[]).unwrap();
    assert_eq!(second.revision, 2);
    assert!(!research::enabled(&case));
    let idn = research::set_grant(&mut case, true, &["login.fïrm.example".into()]).unwrap();
    let stored = &idn.sso_hosts[0];
    assert!(stored.is_ascii() && stored.starts_with("login.xn--") && stored.ends_with(".example"), "internationalized names are stored in ASCII form: {stored}");
    for bad in ["https://login.firm.example", "login.firm.example/path", "localhost", "1.next.westlaw.com", "bad host", "user@firm.example", "*.firm.example", "login_.firm.example", "-login.firm.example", "login.firm.example:443", "10.0.0.1"] {
        assert!(research::set_grant(&mut case, true, &[bad.into()]).is_err(), "{bad}");
    }
    assert!(research::set_grant(&mut case, true, &vec!["a.example".to_string(); 11]).is_err());
    assert_eq!(research::grant(&case).unwrap().unwrap().revision, 3, "refused changes leave the grant unchanged");
    case.verify_audit().unwrap();
}

#[test]
fn applying_app_defaults_never_enables_the_research_browser() {
    let (_dir, mut case) = setup();
    go_online(&mut case);
    let defaults = json!({"config":{"provider":"openai","execution":"auto","review":"standard","pool":[]},"settings":{"offline":false,"allow_text":true,"allow_images":true,"model":"m","case_budget":0.,"input_per_million":0.,"output_per_million":0.}});
    evidence_desk::providers::apply_app_settings(&mut case, &defaults).unwrap();
    assert!(!research::enabled(&case));
    research::set_grant(&mut case, true, &[]).unwrap();
    evidence_desk::providers::apply_app_settings(&mut case, &defaults).unwrap();
    assert!(research::enabled(&case), "app defaults do not clear an explicit case choice either");
}

#[test]
fn research_toggle_survives_backup_and_restore() {
    let (dir, mut case) = setup();
    go_online(&mut case);
    let granted = research::set_grant(&mut case, true, &["login.firm.example".into()]).unwrap();
    let archive = dir.path().join("backup.age");
    backup::backup(&mut case, &archive, "test-only-passphrase-long").unwrap();
    let restored = backup::restore(&archive, &dir.path().join("restored"), "test-only-passphrase-long").unwrap();
    assert_eq!(research::grant(&restored).unwrap(), Some(granted));
    restored.verify_audit().unwrap();
}

#[test]
fn research_profile_must_stay_outside_the_case_folder() {
    let (dir, case) = setup();
    assert!(research::ensure_profile_boundary(&case.root, &case.root.join("research-profile")).is_err());
    assert!(research::ensure_profile_boundary(&case.root, &dir.path().join("elsewhere")).is_ok());
    assert!(research::ensure_profile_boundary(&case.root, dir.path()).is_err(), "a profile containing the case is refused");
}

#[test]
fn a_corrupt_research_grant_can_still_be_switched_off() {
    let (_dir, mut case) = setup();
    go_online(&mut case);
    case.set_meta("research_browser_grant", "{not json").unwrap();
    assert!(research::set_grant(&mut case, true, &[]).is_err());
    let off = research::set_grant(&mut case, false, &[]).unwrap();
    assert!(!off.enabled && !research::enabled(&case));
}
