use evidence_desk::{agent, case::Case};
use serde_json::json;
fn setup() -> (tempfile::TempDir, Case, String, String) {
    let dir = tempfile::tempdir().unwrap();
    let mut case = Case::create(&dir.path().join("case"), "Synthetic intelligence").unwrap();
    let file = dir.path().join("report.txt");
    std::fs::write(&file, "The witness reports three objects.\nA second account reports four.").unwrap();
    case.import_files(&[file.to_string_lossy().into_owned()], "synthetic").unwrap();
    let source = case.sources().unwrap()[0].id.clone();
    let mut settings = case.settings().unwrap();
    settings.offline = false; settings.allow_text = true; settings.allow_images = true; settings.model = "synthetic".into();
    case.save_settings(settings).unwrap();
    let task = agent::start(&mut case, "Compare the accounts", "investigate", vec![source.clone()], vec![], 0.).unwrap();
    (dir, case, source, task)
}
#[test]
fn ordinary_chat_never_advertises_automatic_only_batch_on_either_route() {
    let (_dir, mut case, _, task) = setup();
    assert!(!agent::available_tools(&case, &task).unwrap().iter().any(|t| t["name"] == "inspect_automatic_video_batch"));
    case.set_meta(&format!("task_access_route:{task}"), "chatgpt_subscription").unwrap();
    let (_, tools, _) = agent::subscription_context(&mut case, &task).unwrap();
    assert!(!tools.iter().any(|t| t["name"] == "inspect_automatic_video_batch"));
    let error = agent::execute_tool(&mut case, &task, "inspect_automatic_video_batch", &json!({})).unwrap_err().to_string();
    assert!(error.starts_with("wrong_task_purpose:"), "{error}");
}
#[test]
fn visual_tool_catalogue_tracks_live_case_grants() {
    let (_dir, mut case, _, task) = setup();
    case.set_meta(&format!("automatic_task:{task}"), "true").unwrap();
    assert!(agent::available_tools(&case, &task).unwrap().iter().any(|t| t["name"] == "inspect_automatic_video_batch"));
    let mut settings = case.settings().unwrap(); settings.allow_images = false;
    case.save_settings(settings).unwrap();
    let tools = agent::available_tools(&case, &task).unwrap();
    for name in ["inspect_automatic_video_batch", "inspect_artifact_image", "inspect_video_interval", "inspect_document_pages"] {
        assert!(!tools.iter().any(|t| t["name"] == name), "{name}");
    }
}
