import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    kotlin("jvm") version "1.9.25"
    kotlin("plugin.serialization") version "1.9.25"
    `java-library`
    `maven-publish`
    signing
}

group = "io.github.harrisoncn"
// Release version: -PreleaseVersion=1.7.0 (set by .github/workflows/clients-publish.yml from the git tag).
version = (findProperty("releaseVersion") as String?) ?: "1.7.0"

dependencies {
    api("com.squareup.okhttp3:okhttp:4.12.0")
    api("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")

    testImplementation(kotlin("test"))
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}

java {
    // Java 11 bytecode: usable from Android (minSdk 21+ with desugaring) and any JVM 11+.
    sourceCompatibility = JavaVersion.VERSION_11
    targetCompatibility = JavaVersion.VERSION_11
    withSourcesJar()
    // Maven Central requires a javadoc jar (empty is accepted for Kotlin-only libraries).
    withJavadocJar()
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_11)
        explicitApi()
    }
}

tasks.test {
    useJUnitPlatform()
}

publishing {
    publications {
        create<MavenPublication>("maven") {
            from(components["java"])
            artifactId = "mcp-gateway-client"
            pom {
                name.set("mcp-gateway-client")
                description.set("Kotlin / JVM / Android client for mcp-gateway (REST API + MCP over /mcp).")
                url.set("https://github.com/HarrisonCN/mcp-gateway")
                licenses {
                    license {
                        name.set("MIT License")
                        url.set("https://opensource.org/licenses/MIT")
                    }
                }
                developers {
                    developer {
                        id.set("HarrisonCN")
                        name.set("HarrisonCN")
                        url.set("https://github.com/HarrisonCN")
                    }
                }
                scm {
                    url.set("https://github.com/HarrisonCN/mcp-gateway")
                    connection.set("scm:git:https://github.com/HarrisonCN/mcp-gateway.git")
                    developerConnection.set("scm:git:ssh://git@github.com/HarrisonCN/mcp-gateway.git")
                }
            }
        }
    }
    repositories {
        // Local staging repository; the publish workflow zips it into a Central Portal bundle.
        maven {
            name = "staging"
            url = uri(layout.buildDirectory.dir("staging-deploy"))
        }
    }
}

// Signing is only active when a key is provided (CI release job); local builds stay unsigned.
// ORG_GRADLE_PROJECT_signingKey / ORG_GRADLE_PROJECT_signingPassword (ASCII-armored secret key).
val signingKey = findProperty("signingKey") as String?
signing {
    isRequired = signingKey != null
    if (signingKey != null) {
        useInMemoryPgpKeys(signingKey, findProperty("signingPassword") as String? ?: "")
        sign(publishing.publications["maven"])
    }
}
