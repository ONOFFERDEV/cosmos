// clusters table: create/lookup/update/delete — includes scope-local operations (count/delete/reset _for_owner_scope).

use super::*;

impl Store {
    pub fn count_clusters(&self) -> Result<i64> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row("SELECT COUNT(*) FROM clusters", [], |r| r.get(0))
            .context("counting clusters")
    }

    /// M9 scoped bootstrap: cluster count within one exact scope (`None` =
    /// shared clusters only) — the `ClustersExist` check must not force a
    /// first-time personal bootstrap just because shared clusters exist.
    pub fn count_clusters_for_owner_scope(&self, owner: Option<&str>) -> Result<i64> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        match owner {
            Some(o) => conn
                .query_row("SELECT COUNT(*) FROM clusters WHERE owner = ?1", params![o], |r| r.get(0))
                .context("counting clusters for owner"),
            None => conn
                .query_row("SELECT COUNT(*) FROM clusters WHERE owner IS NULL", [], |r| r.get(0))
                .context("counting shared clusters"),
        }
    }

    /// M9 scoped bootstrap (force=true): delete only the given scope's
    /// clusters, leaving every other scope's clusters and assignments intact.
    pub fn delete_clusters_for_owner_scope(&self, owner: Option<&str>) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        match owner {
            Some(o) => conn
                .execute("DELETE FROM clusters WHERE owner = ?1", params![o])
                .context("deleting clusters for owner")?,
            None => conn
                .execute("DELETE FROM clusters WHERE owner IS NULL", [])
                .context("deleting shared clusters")?,
        };
        Ok(())
    }

    /// Deletes all cluster rows (used by `bootstrap(force=true)` before
    /// regenerating). Caller is responsible for also resetting
    /// `chunks.cluster_ids` and journaling the reset.
    pub fn delete_all_clusters(&self) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute("DELETE FROM clusters", []).context("deleting all clusters")?;
        Ok(())
    }

    /// Inserts a newly-born cluster (name/description NULL per spec).
    #[allow(clippy::too_many_arguments)]
    pub fn insert_cluster(
        &self,
        id: &str,
        slug: &str,
        status: &str,
        centroid: &[u8],
        updated_at: &str,
        owner: Option<&str>,
    ) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "INSERT INTO clusters(id, slug, name, description, status, centroid, updated_at, owner)
             VALUES (?1, ?2, NULL, NULL, ?3, ?4, ?5, ?6)",
            params![id, slug, status, centroid, updated_at, owner],
        )
        .context("inserting cluster")?;
        Ok(())
    }

    pub fn list_cluster_rows(&self) -> Result<Vec<ClusterRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id, slug, name, description, status, centroid, updated_at, owner FROM clusters ORDER BY slug ASC")
            .context("preparing cluster listing query")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ClusterRow {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    status: row.get(4)?,
                    centroid: row.get(5)?,
                    updated_at: row.get(6)?,
                    owner: row.get(7)?,
                })
            })
            .context("querying clusters")?
            .collect::<rusqlite::Result<Vec<ClusterRow>>>()
            .context("collecting clusters")?;
        Ok(rows)
    }

    pub fn get_cluster_row(&self, cluster_id: &str) -> Result<Option<ClusterRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT id, slug, name, description, status, centroid, updated_at, owner FROM clusters WHERE id = ?1",
            params![cluster_id],
            |row| {
                Ok(ClusterRow {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    status: row.get(4)?,
                    centroid: row.get(5)?,
                    updated_at: row.get(6)?,
                    owner: row.get(7)?,
                })
            },
        )
        .optional()
        .context("querying cluster by id")
    }

    /// Partial update: `None` fields leave the existing column value
    /// unchanged (`COALESCE`). Returns `true` if a row was found and updated.
    pub fn update_cluster_row(
        &self,
        cluster_id: &str,
        slug: Option<&str>,
        name: Option<&str>,
        description: Option<&str>,
        updated_at: &str,
    ) -> Result<bool> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let affected = conn
            .execute(
                "UPDATE clusters SET
                    slug = COALESCE(?1, slug),
                    name = COALESCE(?2, name),
                    description = COALESCE(?3, description),
                    updated_at = ?4
                 WHERE id = ?5",
                params![slug, name, description, updated_at, cluster_id],
            )
            .context("updating cluster")?;
        Ok(affected > 0)
    }

    /// Active clusters that have a centroid (i.e. survived bootstrap), for
    /// `/route` scoring.
    pub fn active_clusters_with_centroid(&self) -> Result<Vec<ClusterRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, slug, name, description, status, centroid, updated_at, owner
                 FROM clusters WHERE status = 'active' AND centroid IS NOT NULL",
            )
            .context("preparing active cluster query")?;
        let rows = stmt
            .query_map([], |row| {
                Ok(ClusterRow {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    status: row.get(4)?,
                    centroid: row.get(5)?,
                    updated_at: row.get(6)?,
                    owner: row.get(7)?,
                })
            })
            .context("querying active clusters")?
            .collect::<rusqlite::Result<Vec<ClusterRow>>>()
            .context("collecting active clusters")?;
        Ok(rows)
    }

    /// M9: clusters visible to `owner`'s personal ingest scope — `owner`'s
    /// own clusters when `Some`, or shared (`owner IS NULL`) clusters when
    /// `None`. Used for per-owner cluster argmax at ingest time.
    pub fn clusters_for_owner(&self, owner: Option<&str>) -> Result<Vec<ClusterRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, slug, name, description, status, centroid, updated_at, owner
                 FROM clusters WHERE owner IS ?1 AND status = 'active' AND centroid IS NOT NULL",
            )
            .context("preparing clusters_for_owner query")?;
        let rows = stmt
            .query_map(params![owner], |row| {
                Ok(ClusterRow {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    status: row.get(4)?,
                    centroid: row.get(5)?,
                    updated_at: row.get(6)?,
                    owner: row.get(7)?,
                })
            })
            .context("querying clusters for owner")?
            .collect::<rusqlite::Result<Vec<ClusterRow>>>()
            .context("collecting clusters for owner")?;
        Ok(rows)
    }

    /// Full cluster row (including `sensitivity`/`created_by`/`stats_json`
    /// not exposed by `ClusterRow`), for `/clusters/merge`'s src-row snapshot.
    pub fn get_cluster_full_row(&self, cluster_id: &str) -> Result<Option<ClusterFullRow>> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.query_row(
            "SELECT id, slug, name, description, status, sensitivity, created_by, stats_json, centroid, updated_at
             FROM clusters WHERE id = ?1",
            params![cluster_id],
            |row| {
                Ok(ClusterFullRow {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    status: row.get(4)?,
                    sensitivity: row.get(5)?,
                    created_by: row.get(6)?,
                    stats_json: row.get(7)?,
                    centroid: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            },
        )
        .optional()
        .context("querying full cluster row by id")
    }

    /// Sets a cluster's `status` + `stats_json` (used by `/clusters/merge` to
    /// mark the src cluster `status='merged'` and record `merged_into`).
    pub fn set_cluster_status_and_stats(&self, cluster_id: &str, status: &str, stats_json: &str, updated_at: &str) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "UPDATE clusters SET status = ?1, stats_json = ?2, updated_at = ?3 WHERE id = ?4",
            params![status, stats_json, updated_at, cluster_id],
        )
        .context("updating cluster status/stats")?;
        Ok(())
    }

    /// Overwrites just the centroid (used by `/clusters/merge` to set dst's
    /// recalculated centroid).
    pub fn update_cluster_centroid(&self, cluster_id: &str, centroid: &[u8], updated_at: &str) -> Result<()> {
        let conn = self.conn.lock().expect("sqlite mutex poisoned");
        conn.execute(
            "UPDATE clusters SET centroid = ?1, updated_at = ?2 WHERE id = ?3",
            params![centroid, updated_at, cluster_id],
        )
        .context("updating cluster centroid")?;
        Ok(())
    }
}
