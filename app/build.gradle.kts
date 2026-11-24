plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.jessper.app"
    compileSdk = 34
    ndkVersion = "26.1.10909125"

    defaultConfig {
        applicationId = "com.jessper.app"
        minSdk = 26            // AAudio (camino de baja latencia de Oboe) existe desde Android 8.0
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86_64") }
        externalNativeBuild {
            cmake {
                cppFlags += "-std=c++17"
                arguments += "-DANDROID_STL=c++_shared"      // Oboe (prefab) necesita STL compartido
            }
        }
    }

    externalNativeBuild {
        cmake { path = file("src/main/cpp/android/CMakeLists.txt") }
    }
    buildFeatures { prefab = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    buildTypes {
        release { isMinifyEnabled = false }
    }
}

dependencies {
    implementation("com.google.oboe:oboe:1.9.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.0")
}
