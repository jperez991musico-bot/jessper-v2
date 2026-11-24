cmake_minimum_required(VERSION 3.22)
project(stageloop_native)
set(CMAKE_CXX_STANDARD 17)

find_package(oboe REQUIRED CONFIG)      # build.gradle: implementation("com.google.oboe:oboe:1.9.0") + buildFeatures { prefab = true }

add_library(stageloop_native SHARED
    native_audio.cpp
    ../engine/AudioEngine.cpp)
target_include_directories(stageloop_native PRIVATE ../engine)
target_compile_options(stageloop_native PRIVATE -O3 -ffast-math)
target_link_libraries(stageloop_native oboe::oboe log)
