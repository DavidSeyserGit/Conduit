mod commands;
mod goal_persistence;
mod local_harness;

use tauri::{Emitter, Manager};
use tauri_plugin_deep_link::DeepLinkExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    #[cfg(any(windows, target_os = "linux"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _args, _cwd| {}));

    builder
        .plugin(tauri_plugin_deep_link::init())
        .manage(local_harness::HarnessProcessState::default())
        .manage(goal_persistence::GoalPersistenceState::default())
        .setup(|app| {
            #[cfg(any(windows, target_os = "linux"))]
            app.deep_link().register_all()?;
            let app_handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                let urls = event
                    .urls()
                    .into_iter()
                    .map(|url| url.to_string())
                    .collect::<Vec<_>>();
                let _ = app_handle.emit("conduit:deep-link", urls);
            });
            let app_data_dir = app.path().app_data_dir()?;
            app.state::<goal_persistence::GoalPersistenceState>()
                .initialize(app_data_dir);
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::tool_execute,
            commands::report_export_write,
            commands::github_client_id,
            commands::neon_auth_session_get,
            commands::neon_auth_session_store,
            commands::github_get_token,
            commands::github_store_token,
            commands::github_device_start,
            commands::github_device_poll,
            commands::openrouter_get_key,
            commands::openrouter_store_key,
            commands::git_clone_repo,
            commands::git_worktree_create,
            commands::git_worktree_remove,
            commands::git_handoff_status,
            commands::git_commit_changes,
            commands::git_push_branch,
            local_harness::local_harness_models,
            local_harness::local_harness_health,
            local_harness::local_harness_response,
            local_harness::local_harness_coding_iteration,
            local_harness::local_harness_cancel,
            goal_persistence::goal_storage_status,
            goal_persistence::goal_storage_write,
            goal_persistence::goal_storage_read,
            goal_persistence::goal_artifact_write,
            goal_persistence::goal_artifact_read,
            goal_persistence::goal_artifact_cleanup,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
