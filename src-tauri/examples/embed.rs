use mozilla_assist_lib::embedding::get_embedding;

// Note: this must be built with "--release" in order to work. If you run it without building for release, it will just hang.
fn main() -> Result<(), anyhow::Error> {
    let embedding = get_embedding("Hello, world!")?;
    println!("{:?}", embedding);
    Ok(())
}
