use crate::error::{AppError, AppResult};
use crate::state::TaskReporter;
use futures_util::StreamExt;
use std::path::Path;
use tokio::io::AsyncWriteExt;

/// Stream a URL to disk, reporting progress. Writes to `<dest>.part` and renames on success.
pub async fn download(
    http: &reqwest::Client,
    url: &str,
    dest: &Path,
    reporter: Option<&TaskReporter>,
    label: &str,
) -> AppResult<()> {
    if let Some(p) = dest.parent() {
        tokio::fs::create_dir_all(p).await?;
    }
    let resp = http.get(url).send().await?.error_for_status()?;
    let total = resp.content_length();
    let part = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&part).await?;
    let mut stream = resp.bytes_stream();
    let mut got: u64 = 0;
    let mut last_emit = std::time::Instant::now();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        got += chunk.len() as u64;
        if let Some(r) = reporter {
            if last_emit.elapsed().as_millis() > 120 {
                last_emit = std::time::Instant::now();
                let pct = total.map(|t| got as f64 / t.max(1) as f64);
                r.progress(
                    &format!("Downloading {label} – {:.1} MB", got as f64 / 1_048_576.0),
                    pct,
                );
            }
        }
    }
    file.flush().await?;
    drop(file);
    if got == 0 {
        return Err(AppError::msg(format!("Downloaded file from {url} was empty")));
    }
    tokio::fs::rename(&part, dest).await?;
    Ok(())
}

/// Extract a zip on a blocking thread, refusing entries that would escape `dest`.
pub async fn extract_zip(zip_path: &Path, dest: &Path) -> AppResult<()> {
    let zip_path = zip_path.to_path_buf();
    let dest = dest.to_path_buf();
    tokio::task::spawn_blocking(move || -> AppResult<()> {
        let f = std::fs::File::open(&zip_path)?;
        let mut archive = zip::ZipArchive::new(f)?;
        for i in 0..archive.len() {
            let mut entry = archive.by_index(i)?;
            let Some(rel) = entry.enclosed_name() else { continue };
            let out = dest.join(rel);
            if entry.is_dir() {
                std::fs::create_dir_all(&out)?;
            } else {
                if let Some(p) = out.parent() {
                    std::fs::create_dir_all(p)?;
                }
                let mut w = std::fs::File::create(&out)?;
                std::io::copy(&mut entry, &mut w)?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| AppError::msg(e.to_string()))?
}
