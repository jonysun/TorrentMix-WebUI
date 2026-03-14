use rusqlite_migration::{M, Migrations};

pub fn catalog_migrations() -> Migrations<'static> {
  Migrations::new(vec![M::up(include_str!("01_init.sql"))])
}
