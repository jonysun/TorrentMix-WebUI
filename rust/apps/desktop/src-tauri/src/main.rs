#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  net::{IpAddr, Ipv4Addr, SocketAddr},
  path::PathBuf,
  time::Duration,
};

use anyhow::{anyhow, Context, Result};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::{fmt, EnvFilter};

const ENV_CATALOG_DB: &str = "STANDALONE_DB";

fn main() {
  let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
  fmt().with_env_filter(filter).init();

  tauri::Builder::default()
    .setup(|app| {
      let static_dir = resolve_static_dir()?;
      let catalog_db_path = resolve_catalog_db_path(app)?;

      let addr = tauri::async_runtime::block_on(async move {
        let listen = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0);
        let listener = tokio::net::TcpListener::bind(listen)
          .await
          .context("bind gateway listener")?;
        let addr = gateway::spawn_with_listener(listener, static_dir, catalog_db_path)
          .await
          .context("start gateway")?;
        tokio::time::sleep(Duration::from_millis(50)).await;
        Ok::<SocketAddr, anyhow::Error>(addr)
      })?;

      let url = format!("http://127.0.0.1:{}/", addr.port());
      let url = url.parse().context("parse gateway url")?;

      WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
        .title("TorrentMix")
        .build()
        .context("create main window")?;

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("tauri run failed");
}

fn resolve_static_dir() -> Result<PathBuf> {
  if let Ok(value) = std::env::var("STATIC_DIR") {
    let value = value.trim();
    if !value.is_empty() {
      return Ok(PathBuf::from(value));
    }
  }

  let cwd = std::env::current_dir().context("get current dir")?;
  let by_cwd = cwd.join("dist");
  if by_cwd.join("index.html").exists() {
    return Ok(by_cwd);
  }

  let exe = std::env::current_exe().context("get current exe")?;
  if let Some(dir) = exe.parent() {
    let by_exe = dir.join("dist");
    if by_exe.join("index.html").exists() {
      return Ok(by_exe);
    }
  }

  Err(anyhow!(
    "找不到前端静态资源目录：请先运行 `pnpm build` 生成 dist/，或设置 STATIC_DIR"
  ))
}

fn resolve_catalog_db_path(app: &tauri::App) -> Result<PathBuf> {
  if let Ok(value) = std::env::var(ENV_CATALOG_DB) {
    let value = value.trim();
    if !value.is_empty() {
      return Ok(PathBuf::from(value));
    }
  }

  let dir = app
    .path()
    .app_config_dir()
    .context("resolve app config dir")?;
  Ok(dir.join("catalog.db"))
}
