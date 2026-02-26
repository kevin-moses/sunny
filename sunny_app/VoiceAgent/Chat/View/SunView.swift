import Noise
import SwiftUI

/// Uses perlin noise generated within a circle to create a sun effect
struct SunView: View {
    /// import Perlin3D
    var noise = GradientNoise2D(amplitude: 1.0, frequency: 2.0, seed: 3)

    var body: some View {
        Text("Hello, world!")
    }
}

#Preview {
    SunView()
}
