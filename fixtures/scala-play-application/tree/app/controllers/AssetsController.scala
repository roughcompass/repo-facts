package controllers

import com.google.inject.Inject
import error.LocalErrorHandler
import play.api.Environment

class AssetsController @Inject() (
  localErrorHandler: LocalErrorHandler,
  assetsMetaData: AssetsMetadata,
  environment: Environment
) extends AssetsBuilder(localErrorHandler, assetsMetaData, environment)
