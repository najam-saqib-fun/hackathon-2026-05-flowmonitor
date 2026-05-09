cmake_minimum_required(VERSION 3.10)
project(FlowMonitor CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# ---- Dependencies ----------------------------------------------------------
find_package(PkgConfig REQUIRED)
pkg_check_modules(PCAP REQUIRED libpcap)

# PostgreSQL client (libpq). Try pkg-config first, then CMake's FindPostgreSQL,
# then a manual header/library search (useful when only the runtime .so is
# installed without the -dev package).
pkg_check_modules(LIBPQ libpq)
if(NOT LIBPQ_FOUND)
    find_package(PostgreSQL QUIET)
    if(PostgreSQL_FOUND)
        set(LIBPQ_INCLUDE_DIRS ${PostgreSQL_INCLUDE_DIRS})
        set(LIBPQ_LIBRARIES    ${PostgreSQL_LIBRARIES})
        set(LIBPQ_LIBRARY_DIRS "")
        set(LIBPQ_FOUND TRUE)
    endif()
endif()
if(NOT LIBPQ_FOUND)
    find_path(LIBPQ_INCLUDE_DIR
        NAMES libpq-fe.h
        PATHS /usr/include /usr/local/include /usr/include/postgresql
              /usr/local/include/postgresql /opt/homebrew/include
    )
    find_library(LIBPQ_LIBRARY
        NAMES pq
        PATHS /usr/lib /usr/local/lib /usr/lib/x86_64-linux-gnu
              /usr/lib/aarch64-linux-gnu /opt/homebrew/lib
    )
    if(LIBPQ_INCLUDE_DIR AND LIBPQ_LIBRARY)
        set(LIBPQ_INCLUDE_DIRS ${LIBPQ_INCLUDE_DIR})
        set(LIBPQ_LIBRARIES    ${LIBPQ_LIBRARY})
        set(LIBPQ_LIBRARY_DIRS "")
        set(LIBPQ_FOUND TRUE)
    endif()
endif()
if(NOT LIBPQ_FOUND)
    message(FATAL_ERROR
        "libpq not found. Install libpq-dev (Debian/Ubuntu) or postgresql-devel (RHEL/Fedora).")
endif()

# nDPI sometimes ships a libndpi.pc, sometimes not. Try pkg-config first;
# fall back to find_path/find_library hunting in the usual install prefixes.
pkg_check_modules(NDPI libndpi)
if(NOT NDPI_FOUND)
    find_path(NDPI_INCLUDE_DIR
        NAMES ndpi/ndpi_api.h
        PATHS /usr/include /usr/local/include /opt/local/include
    )
    find_library(NDPI_LIBRARY
        NAMES ndpi
        PATHS /usr/lib /usr/local/lib /opt/local/lib /usr/lib/x86_64-linux-gnu
    )
    if(NOT NDPI_INCLUDE_DIR OR NOT NDPI_LIBRARY)
        message(FATAL_ERROR
            "nDPI not found. Install libndpi-dev or build nDPI from source.")
    endif()
    set(NDPI_INCLUDE_DIRS ${NDPI_INCLUDE_DIR})
    set(NDPI_LIBRARIES    ${NDPI_LIBRARY})
endif()

# ---- pcap_processor --------------------------------------------------------
add_executable(pcap_processor src/pcap_processor.cpp)
target_include_directories(pcap_processor PRIVATE
    src
    ${PCAP_INCLUDE_DIRS}
)
target_link_directories(pcap_processor PRIVATE ${PCAP_LIBRARY_DIRS})
target_link_libraries(pcap_processor PRIVATE
    ${PCAP_LIBRARIES}
    pthread
)
target_compile_options(pcap_processor PRIVATE -O2 -Wall -Wextra)

# ---- flow_monitor ----------------------------------------------------------
add_executable(flow_monitor src/flow_monitor.cpp)

# nDPI's pkg-config typically reports `-I.../include/ndpi` so unprefixed
# includes (`#include <ndpi_api.h>`) work. We use `<ndpi/...>` includes so
# we also add the parent of every reported include dir.
set(NDPI_PARENT_INCLUDES "")
foreach(d ${NDPI_INCLUDE_DIRS})
    get_filename_component(dp "${d}" DIRECTORY)
    list(APPEND NDPI_PARENT_INCLUDES "${dp}")
endforeach()

target_include_directories(flow_monitor PRIVATE
    src
    ${NDPI_INCLUDE_DIRS}
    ${NDPI_PARENT_INCLUDES}
    ${LIBPQ_INCLUDE_DIRS}
    ${PCAP_INCLUDE_DIRS}
)
target_link_directories(flow_monitor PRIVATE
    ${NDPI_LIBRARY_DIRS}
    ${LIBPQ_LIBRARY_DIRS}
    ${PCAP_LIBRARY_DIRS}
)
target_link_libraries(flow_monitor PRIVATE
    ${NDPI_LIBRARIES}
    ${LIBPQ_LIBRARIES}
    ${PCAP_LIBRARIES}
    pthread
)
target_compile_options(flow_monitor PRIVATE -O2 -Wall -Wextra)

install(TARGETS pcap_processor flow_monitor RUNTIME DESTINATION bin)
