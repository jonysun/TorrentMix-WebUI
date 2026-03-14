use std::collections::HashMap;

use anyhow::{anyhow, Context, Result};
use axum_extra::extract::cookie::CookieJar;
use serde::{Deserialize, Serialize};
use url::Url;

pub const COOKIE_SELECTED_SERVER: &str = "tm_server_id";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendType {
  Qbit,
  Trans,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerConfig {
  #[serde(default)]
  pub id: String,
  #[serde(default)]
  pub name: String,
  #[serde(rename = "type")]
  pub kind: BackendType,
  #[serde(default)]
  pub base_url: String,
  #[serde(default)]
  pub username: String,
  #[serde(default)]
  pub password: String,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CatalogConfig {
  #[serde(default)]
  pub default_server_id: String,
  #[serde(default)]
  pub servers: Vec<ServerConfig>,
}

#[derive(Debug, Clone)]
pub struct ServerEntry {
  pub cfg: ServerConfig,
  pub base: Url,
  pub origin: String,
}

#[derive(Debug, Clone, Default)]
pub struct Catalog {
  pub default_id: String,
  pub servers: HashMap<String, ServerEntry>,
  pub order: Vec<String>,
}

impl Catalog {
  pub fn from_config(mut cfg: CatalogConfig) -> Result<Self> {
    cfg.default_server_id = cfg.default_server_id.trim().to_string();

    let mut servers = HashMap::with_capacity(cfg.servers.len());
    let mut order = Vec::with_capacity(cfg.servers.len());

    for mut server in cfg.servers.drain(..) {
      server.id = server.id.trim().to_string();
      server.name = server.name.trim().to_string();
      server.base_url = server.base_url.trim().to_string();
      server.username = server.username.trim().to_string();
      server.password = server.password.trim().to_string();

      if server.id.is_empty() {
        return Err(anyhow!("server.id is required"));
      }
      if server.name.is_empty() {
        server.name = server.id.clone();
      }
      if server.base_url.is_empty() {
        return Err(anyhow!("server {:?}: baseUrl is required", server.id));
      }
      if server.kind == BackendType::Qbit
        && server.username.is_empty()
        && server.password.is_empty()
      {
        return Err(anyhow!(
          "qBittorrent server {:?} requires username/password",
          server.id
        ));
      }
      if servers.contains_key(&server.id) {
        return Err(anyhow!("duplicate server id: {:?}", server.id));
      }

      let base = Url::parse(&server.base_url)
        .with_context(|| format!("server {:?}: invalid baseUrl {:?}", server.id, server.base_url))?;
      if base.scheme().is_empty() || base.host_str().is_none() {
        return Err(anyhow!("server {:?}: invalid baseUrl {:?}", server.id, server.base_url));
      }

      let host = base.host_str().expect("validated host");
      let host_for_origin = format_host_only(host);
      let origin = if let Some(port) = base.port() {
        format!("{}://{}:{}", base.scheme(), host_for_origin, port)
      } else {
        format!("{}://{}", base.scheme(), host_for_origin)
      };

      let id = server.id.clone();
      order.push(id.clone());
      servers.insert(
        id,
        ServerEntry {
          cfg: server,
          base,
          origin,
        },
      );
    }

    let default_id = if order.is_empty() {
      if cfg.default_server_id.is_empty() {
        String::new()
      } else {
        return Err(anyhow!(
          "defaultServerId {:?} not found in servers",
          cfg.default_server_id
        ));
      }
    } else if cfg.default_server_id.is_empty() {
      order[0].clone()
    } else if servers.contains_key(&cfg.default_server_id) {
      cfg.default_server_id
    } else {
      return Err(anyhow!(
        "defaultServerId {:?} not found in servers",
        cfg.default_server_id
      ));
    };

    Ok(Self {
      default_id,
      servers,
      order,
    })
  }

  pub fn selected_id<'a>(&'a self, jar: &'a CookieJar) -> Option<&'a str> {
    if let Some(cookie) = jar.get(COOKIE_SELECTED_SERVER) {
      let id = cookie.value().trim();
      if !id.is_empty() && self.servers.contains_key(id) {
        return Some(id);
      }
    }

    if self.default_id.is_empty() {
      None
    } else {
      Some(&self.default_id)
    }
  }

  pub fn pick<'a>(&'a self, jar: &'a CookieJar) -> Option<&'a ServerEntry> {
    let id = self.selected_id(jar)?;
    self.servers.get(id)
  }
}

fn format_host_only(host: &str) -> String {
  if host.contains(':') && !host.starts_with('[') {
    format!("[{host}]")
  } else {
    host.to_string()
  }
}
