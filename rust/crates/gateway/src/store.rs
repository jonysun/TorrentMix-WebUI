use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};

use crate::{
  catalog::{BackendType, Catalog, CatalogConfig, ServerConfig},
  key::{MasterKeySource, ResolvedMasterKey},
  migrations::catalog_migrations,
};

pub trait CatalogStore: Send + Sync {
  fn load_config(&self) -> Result<CatalogConfig>;
  fn save_config(&self, config: CatalogConfig) -> Result<()>;
  fn key_source(&self) -> MasterKeySource;
  fn database_path(&self) -> &Path;

  fn load_catalog(&self) -> Result<Catalog> {
    Catalog::from_config(self.load_config()?)
  }
}

#[derive(Debug, Clone)]
pub struct SqlCipherCatalogStore {
  db_path: PathBuf,
  key: String,
  key_source: MasterKeySource,
}

impl SqlCipherCatalogStore {
  pub fn bootstrap(db_path: PathBuf, key: ResolvedMasterKey) -> Result<Self> {
    let mut conn = open_catalog_connection(&db_path, &key.secret)?;
    catalog_migrations()
      .to_latest(&mut conn)
      .context("apply catalog migrations")?;
    drop(conn);

    Ok(Self {
      db_path,
      key: key.secret,
      key_source: key.source,
    })
  }

  fn open_connection(&self) -> Result<Connection> {
    open_catalog_connection(&self.db_path, &self.key)
  }
}

impl CatalogStore for SqlCipherCatalogStore {
  fn load_config(&self) -> Result<CatalogConfig> {
    let conn = self.open_connection()?;
    let default_server_id = conn
      .query_row(
        "SELECT value FROM settings WHERE key = 'default_server_id'",
        [],
        |row| row.get::<_, String>(0),
      )
      .optional()
      .context("read default server id")?
      .unwrap_or_default();

    let mut stmt = conn
      .prepare(
        "
        SELECT id, name, backend_type, base_url, username, password
        FROM servers
        ORDER BY sort_index ASC, id ASC
        ",
      )
      .context("prepare server query")?;

    let mut rows = stmt.query([]).context("query servers")?;
    let mut servers = Vec::new();
    while let Some(row) = rows.next().context("read server row")? {
      let backend_type: String = row.get(2).context("read backend_type")?;
      let kind = parse_backend_type(&backend_type)?;
      servers.push(ServerConfig {
        id: row.get(0).context("read server id")?,
        name: row.get(1).context("read server name")?,
        kind,
        base_url: row.get(3).context("read server base_url")?,
        username: row.get(4).context("read server username")?,
        password: row.get(5).context("read server password")?,
      });
    }

    Ok(CatalogConfig {
      default_server_id,
      servers,
    })
  }

  fn save_config(&self, config: CatalogConfig) -> Result<()> {
    Catalog::from_config(config.clone()).context("validate catalog before save")?;

    let mut conn = self.open_connection()?;
    let tx = conn.transaction().context("begin catalog transaction")?;

    tx.execute("DELETE FROM servers", [])
      .context("clear existing servers")?;
    tx.execute("DELETE FROM settings WHERE key = 'default_server_id'", [])
      .context("clear default server setting")?;

    for (index, server) in config.servers.iter().enumerate() {
      tx.execute(
        "
        INSERT INTO servers (
          id,
          sort_index,
          name,
          backend_type,
          base_url,
          username,
          password
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
        ",
        params![
          server.id,
          index as i64,
          server.name,
          backend_type_as_str(server.kind),
          server.base_url,
          server.username,
          server.password,
        ],
      )
      .with_context(|| format!("insert server {:?}", server.id))?;
    }

    if !config.default_server_id.is_empty() {
      tx.execute(
        "INSERT INTO settings (key, value) VALUES ('default_server_id', ?1)",
        [config.default_server_id.as_str()],
      )
      .context("persist default server id")?;
    }

    tx.commit().context("commit catalog transaction")
  }

  fn key_source(&self) -> MasterKeySource {
    self.key_source
  }

  fn database_path(&self) -> &Path {
    &self.db_path
  }
}

fn open_catalog_connection(db_path: &Path, key: &str) -> Result<Connection> {
  if let Some(parent) = db_path.parent() {
    std::fs::create_dir_all(parent)
      .with_context(|| format!("create catalog db dir: {}", parent.display()))?;
  }

  let flags = OpenFlags::SQLITE_OPEN_CREATE | OpenFlags::SQLITE_OPEN_READ_WRITE;
  let conn = Connection::open_with_flags(db_path, flags)
    .with_context(|| format!("open catalog db: {}", db_path.display()))?;

  apply_sqlcipher_key(&conn, key)?;
  conn
    .execute_batch("PRAGMA foreign_keys = ON;")
    .context("enable foreign keys")?;
  conn
    .query_row("SELECT count(*) FROM sqlite_master", [], |_| Ok(()))
    .context("validate SQLCipher key")?;

  Ok(conn)
}

fn apply_sqlcipher_key(conn: &Connection, key: &str) -> Result<()> {
  let escaped = key.replace('\'', "''");
  conn
    .execute_batch(&format!("PRAGMA key = '{escaped}';"))
    .context("set SQLCipher key")
}

fn parse_backend_type(value: &str) -> Result<BackendType> {
  match value {
    "qbit" => Ok(BackendType::Qbit),
    "trans" => Ok(BackendType::Trans),
    other => Err(anyhow!("unknown backend type in catalog db: {other}")),
  }
}

fn backend_type_as_str(kind: BackendType) -> &'static str {
  match kind {
    BackendType::Qbit => "qbit",
    BackendType::Trans => "trans",
  }
}

#[cfg(test)]
mod tests {
  use std::path::Path;

  use anyhow::Result;
  use tempfile::tempdir;

  use crate::{
    catalog::{BackendType, CatalogConfig, ServerConfig},
    key::{MasterKeySource, ResolvedMasterKey},
  };

  use super::{CatalogStore, SqlCipherCatalogStore};

  fn resolved(secret: &str) -> ResolvedMasterKey {
    ResolvedMasterKey {
      secret: secret.to_string(),
      source: MasterKeySource::Environment,
    }
  }

  #[test]
  fn initializes_empty_catalog_database() -> Result<()> {
    let dir = tempdir()?;
    let db_path = dir.path().join("catalog.db");
    let store = SqlCipherCatalogStore::bootstrap(db_path.clone(), resolved("secret-1"))?;

    let catalog = store.load_catalog()?;
    assert!(Path::new(&db_path).exists());
    assert!(catalog.order.is_empty());
    assert!(catalog.default_id.is_empty());
    Ok(())
  }

  #[test]
  fn persists_and_reloads_catalog() -> Result<()> {
    let dir = tempdir()?;
    let db_path = dir.path().join("catalog.db");
    let store = SqlCipherCatalogStore::bootstrap(db_path, resolved("secret-2"))?;

    store.save_config(CatalogConfig {
      default_server_id: "home-qb".to_string(),
      servers: vec![
        ServerConfig {
          id: "home-qb".to_string(),
          name: "Home qB".to_string(),
          kind: BackendType::Qbit,
          base_url: "http://127.0.0.1:8080".to_string(),
          username: "admin".to_string(),
          password: "secret".to_string(),
        },
        ServerConfig {
          id: "nas-trans".to_string(),
          name: "NAS Transmission".to_string(),
          kind: BackendType::Trans,
          base_url: "http://127.0.0.1:9091".to_string(),
          username: "".to_string(),
          password: "".to_string(),
        },
      ],
    })?;

    let config = store.load_config()?;
    assert_eq!(config.default_server_id, "home-qb");
    assert_eq!(config.servers.len(), 2);
    assert_eq!(config.servers[0].id, "home-qb");
    assert_eq!(config.servers[0].password, "secret");
    assert_eq!(config.servers[1].id, "nas-trans");
    Ok(())
  }

  #[test]
  fn rejects_wrong_database_key() -> Result<()> {
    let dir = tempdir()?;
    let db_path = dir.path().join("catalog.db");
    let store = SqlCipherCatalogStore::bootstrap(db_path.clone(), resolved("right-key"))?;
    store.save_config(CatalogConfig {
      default_server_id: "home-qb".to_string(),
      servers: vec![ServerConfig {
        id: "home-qb".to_string(),
        name: "Home qB".to_string(),
        kind: BackendType::Qbit,
        base_url: "http://127.0.0.1:8080".to_string(),
        username: "admin".to_string(),
        password: "secret".to_string(),
      }],
    })?;

    let wrong = SqlCipherCatalogStore::bootstrap(db_path, resolved("wrong-key"))
      .expect_err("wrong key should fail");
    assert!(wrong.to_string().contains("SQLCipher") || wrong.to_string().contains("database"));
    Ok(())
  }
}
