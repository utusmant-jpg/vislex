//! Application-wide billing route. Case grants remain in the case database.
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::Path;
use crate::case::Case;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessRoute {
    #[default]
    ApiKeys,
    ChatgptSubscription,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct SubscriptionSelection {
    pub model: String,
    pub effort: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AccessSettings {
    pub route: AccessRoute,
    #[serde(default)]
    pub subscription: Option<SubscriptionSelection>,
}

/// Persist the access choice on a task before its first outbound request.
/// Tasks created before this field existed are API-key tasks.
pub fn snapshot_task(case: &mut Case, task: &str, settings: &AccessSettings) -> Result<()> {
    anyhow::ensure!(case.meta(&format!("task_access:{task}"))?.is_none(),"Task access route is already fixed");
    case.set_meta(&format!("task_access:{task}"), &serde_json::to_string(settings)?)
}

pub fn snapshot_task_if_new(case: &mut Case, task: &str, settings: &AccessSettings) -> Result<()> {
    if case.meta(&format!("task_access:{task}"))?.is_none() {
        snapshot_task(case,task,settings)?;
    }
    Ok(())
}

pub fn task_access(case: &Case, task: &str) -> Result<AccessSettings> {
    match case.meta(&format!("task_access:{task}"))? {
        Some(value) => Ok(serde_json::from_str(&value).context("Invalid task access snapshot")?),
        None => Ok(AccessSettings { route: AccessRoute::ApiKeys, subscription: None }),
    }
}

pub fn read(directory: &Path) -> Result<AccessRoute> {
    Ok(read_settings(directory)?.route)
}

pub fn read_settings(directory: &Path) -> Result<AccessSettings> {
    let path = directory.join("ai-access.json");
    if !path.exists() { return Ok(AccessSettings { route: AccessRoute::ApiKeys, subscription: None }); }
    let bytes = std::fs::read(&path).context("Read AI access preference")?;
    let saved: Saved = serde_json::from_slice(&bytes).context("Invalid AI access preference")?;
    anyhow::ensure!(saved.version == 1, "Unsupported AI access preference version");
    Ok(saved.settings)
}

pub fn write(directory: &Path, route: AccessRoute) -> Result<()> {
    let mut settings = read_settings(directory)?;
    settings.route = route;
    write_settings(directory, settings)
}

pub fn write_settings(directory: &Path, settings: AccessSettings) -> Result<()> {
    std::fs::create_dir_all(directory)?;
    let mut staged = tempfile::NamedTempFile::new_in(directory)?;
    use std::io::Write;
    staged.write_all(&serde_json::to_vec(&Saved { version: 1, settings })?)?;
    staged.as_file().sync_all()?;
    staged.persist(directory.join("ai-access.json"))?;
    Ok(())
}

#[derive(Deserialize, Serialize)]
struct Saved {
    version: u8,
    #[serde(flatten)]
    settings: AccessSettings,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn route_defaults_to_api_and_round_trips_without_a_key() {
        let temp = tempfile::tempdir().unwrap();
        assert_eq!(read(temp.path()).unwrap(), AccessRoute::ApiKeys);
        write(temp.path(), AccessRoute::ChatgptSubscription).unwrap();
        assert_eq!(read(temp.path()).unwrap(), AccessRoute::ChatgptSubscription);
        write_settings(temp.path(), AccessSettings {route: AccessRoute::ApiKeys,
            subscription:Some(SubscriptionSelection {model:"gpt-test".into(),effort:"high".into()})}).unwrap();
        assert_eq!(read_settings(temp.path()).unwrap().subscription.unwrap().effort,"high");
        let raw = std::fs::read_to_string(temp.path().join("ai-access.json")).unwrap();
        assert!(!raw.contains("sk-"));
    }

    #[test]
    fn task_snapshot_survives_global_route_change() {
        let temp=tempfile::tempdir().unwrap();
        let mut case=Case::create(&temp.path().join("case"),"Synthetic case").unwrap();
        let access=AccessSettings {route:AccessRoute::ApiKeys,subscription:None};
        snapshot_task(&mut case,"task-a",&access).unwrap();
        write(temp.path(),AccessRoute::ChatgptSubscription).unwrap();
        assert_eq!(task_access(&case,"task-a").unwrap().route,AccessRoute::ApiKeys);
        assert_eq!(task_access(&case,"legacy-task").unwrap().route,AccessRoute::ApiKeys);
    }
}
