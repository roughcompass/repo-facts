import sbt.*
import uk.gov.hmrc.DefaultBuildSettings.*

val appName = "pertax-frontend"

ThisBuild / majorVersion := 2
ThisBuild / scalaVersion := "3.3.7"

lazy val microservice = Project(appName, file("."))
  .enablePlugins(play.sbt.PlayScala, SbtDistributablesPlugin)
  .settings(
    PlayKeys.playDefaultPort := 9232,
    scalaSettings,
    libraryDependencies ++= AppDependencies.all
  )
