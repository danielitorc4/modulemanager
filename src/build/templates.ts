export function pomTemplate(artifactId: string): string {
    return `<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0
                             http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.modules</groupId>
  <artifactId>${artifactId}</artifactId>
  <version>1.0.0</version>
  <packaging>jar</packaging>
  <properties>
    <maven.compiler.release>17</maven.compiler.release>
  </properties>
  <dependencies>
        <!-- modulemanager:managed-dependencies:start -->
        <!-- no modulemanager dependencies -->
        <!-- modulemanager:managed-dependencies:end -->
  </dependencies>
</project>
`;
}

export function buildGradleTemplate(): string {
    return `plugins {
    id 'java'
}

java {
    toolchains {
        languageVersion = JavaLanguageVersion.current()
    }
}

repositories {
    mavenCentral()
}

dependencies {
    // modulemanager:managed-dependencies:start
    // no modulemanager dependencies
    // modulemanager:managed-dependencies:end
}
`;
}
