mod commands;
mod local_harness;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(local_harness::HarnessProcessState::default())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::tool_execute,
            commands::github_client_id,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
