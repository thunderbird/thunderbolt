/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "net.thunderbird.thunderbolt.pages"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}

dependencies {
    implementation("androidx.webkit:webkit:1.18.0")
    // The public Tauri lifecycle signature uses AppCompatActivity; match Tauri's
    // own dependency without changing the application's runtime resolution.
    compileOnly("androidx.appcompat:appcompat:1.6.0")
    implementation(project(":tauri-android"))
}
