project('orbit-reader-helper', 'c', default_options: ['c_std=c11', 'warning_level=3'])

wayland = dependency('wayland-client', version: '>=1.22')
scanner = find_program('wayland-scanner')
protocols = dependency('wayland-protocols', version: '>=1.37').get_variable(pkgconfig: 'pkgdatadir')
png = dependency('libpng')

specs = [
  ['ext-foreign-toplevel-list-v1', protocols / 'staging/ext-foreign-toplevel-list/ext-foreign-toplevel-list-v1.xml'],
  ['ext-image-capture-source-v1', protocols / 'staging/ext-image-capture-source/ext-image-capture-source-v1.xml'],
  ['ext-image-copy-capture-v1', protocols / 'staging/ext-image-copy-capture/ext-image-copy-capture-v1.xml'],
]
generated = []
foreach spec : specs
  generated += custom_target(spec[0] + '-header', input: spec[1],
    output: spec[0] + '-client-protocol.h',
    command: [scanner, 'client-header', '@INPUT@', '@OUTPUT@'])
  generated += custom_target(spec[0] + '-code', input: spec[1],
    output: spec[0] + '-protocol.c',
    command: [scanner, 'private-code', '@INPUT@', '@OUTPUT@'])
endforeach
executable('orbit-reader-helper', '../reader_helper.c', generated,
  dependencies: [wayland, png], install: false)
