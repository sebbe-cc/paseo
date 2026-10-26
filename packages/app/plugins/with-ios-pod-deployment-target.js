const { withPodfile } = require("expo/config-plugins");

const REACT_NATIVE_POST_INSTALL_END =
  "      :ccache_enabled => ccache_enabled?(podfile_properties),\n    )\n";
const MARKER = "# [paseo] pod deployment targets";
// Xcode 27 refuses any target below iOS 15. React Native's post-install raises the pod
// targets it owns, but resource bundles and prebuilt frameworks keep each podspec's own
// minimum, so the archive fails before compiling anything.
const POST_INSTALL = `    ${MARKER}
    min_ios = podfile_properties['ios.deploymentTarget'] || '15.1'
    installer.pods_project.targets.each do |target|
      target.build_configurations.each do |config|
        if config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'].to_f < min_ios.to_f
          config.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] = min_ios
        end
      end
    end
`;

function configurePodDeploymentTargets(contents) {
  if (contents.includes(MARKER)) {
    return contents;
  }
  if (!contents.includes(REACT_NATIVE_POST_INSTALL_END)) {
    throw new Error("Could not raise pod deployment targets after react_native_post_install");
  }
  return contents.replace(
    REACT_NATIVE_POST_INSTALL_END,
    `${REACT_NATIVE_POST_INSTALL_END}${POST_INSTALL}`,
  );
}

function withIosPodDeploymentTarget(config) {
  return withPodfile(config, (modConfig) => {
    modConfig.modResults.contents = configurePodDeploymentTargets(modConfig.modResults.contents);
    return modConfig;
  });
}

module.exports = withIosPodDeploymentTarget;
module.exports.configurePodDeploymentTargets = configurePodDeploymentTargets;
